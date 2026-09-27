#include "root.h"
#include "ZigSourceProvider.h"
#include <JavaScriptCore/ControlFlowProfiler.h>
#include <JavaScriptCore/SourceCodeKey.h>
#include <JavaScriptCore/UnlinkedCodeBlock.h>
#include <JavaScriptCore/UnlinkedFunctionCodeBlock.h>
#include <JavaScriptCore/UnlinkedFunctionExecutable.h>
#include <wtf/Scope.h>

using namespace JSC;

extern "C" bool CodeCoverage__withBlocksAndFunctions(
    JSC::VM* vmPtr,
    JSC::SourceID sourceID,
    void* ctx,
    void (*blockCallback)(void* ctx, JSC::BasicBlockRange* range, size_t len, size_t functionOffset))
{

    VM& vm = *vmPtr;

    auto basicBlocks = vm.controlFlowProfiler()->getBasicBlocksForSourceIDWithoutFunctionRange(
        sourceID, vm);

    if (basicBlocks.isEmpty()) {
        blockCallback(ctx, nullptr, 0, 0);
        return true;
    }

    size_t functionStartOffset = basicBlocks.size();

    const Vector<std::tuple<bool, unsigned, unsigned>>& functionRanges = vm.functionHasExecutedCache()->getFunctionRanges(sourceID);

    basicBlocks.reserveCapacity(functionRanges.size() + basicBlocks.size());

    for (const auto& functionRange : functionRanges) {
        BasicBlockRange range;
        range.m_hasExecuted = std::get<0>(functionRange);
        range.m_startOffset = static_cast<int>(std::get<1>(functionRange));
        range.m_endOffset = static_cast<int>(std::get<2>(functionRange));
        range.m_executionCount = range.m_hasExecuted
            ? 1
            : 0; // This is a hack. We don't actually count this.
        basicBlocks.append(range);
    }

    blockCallback(ctx, basicBlocks.begin(), basicBlocks.size(), functionStartOffset);
    return true;
}

// The ranges FunctionHasExecutedCache holds for a source that is loaded and of which no function has run, for a text
// that nothing loaded: the source's own range first (ProgramExecutable and ModuleProgramExecutable insert it), then
// what CodeBlock::finishCreation inserts for the top-level code, each range once. For CommonJS the top-level code is
// Bun's wrapper function, which a load calls, so its functions are listed too. Nothing here runs code or writes to a
// profiler: the text is parsed in this thread's bytecode VM. False if it does not parse.
extern "C" bool CodeCoverage__withFunctionsOfText(
    const BunString* sourceURL,
    const BunString* text,
    bool isCommonJS,
    void* ctx,
    void (*callback)(void* ctx, JSC::BasicBlockRange* ranges, size_t len))
{
    VM& vm = Zig::vmForBytecodeCache();
    JSLockHolder locker(vm);
    // The parser's cache is keyed by the source and would keep the text of every file until the VM goes.
    auto clearCaches = makeScopeExit([&] {
        vm.clearSourceProviderCaches();
    });
    SourceCode sourceCode;
    SourceCodeKey key;
    UnlinkedCodeBlock* topLevel = Zig::generateUnlinkedCodeForBytecodeCache(vm, sourceURL, text, !isCommonJS, isCommonJS ? 1 : 0, false, sourceCode, key);
    if (!topLevel)
        return false;

    Vector<std::pair<unsigned, unsigned>> functions;
    auto appendFunctionsOf = [&](UnlinkedCodeBlock* codeBlock) {
        for (size_t i = 0, count = codeBlock->numberOfFunctionDecls(); i < count; ++i) {
            UnlinkedFunctionExecutable* executable = codeBlock->functionDecl(i);
            functions.append({ executable->unlinkedFunctionStart(), executable->unlinkedFunctionEnd() });
        }
        for (size_t i = 0, count = codeBlock->numberOfFunctionExprs(); i < count; ++i) {
            UnlinkedFunctionExecutable* executable = codeBlock->functionExpr(i);
            functions.append({ executable->unlinkedFunctionStart(), executable->unlinkedFunctionEnd() });
        }
    };
    appendFunctionsOf(topLevel);
    if (isCommonJS) {
        for (size_t i = 0, count = topLevel->numberOfFunctionExprs(); i < count; ++i) {
            if (auto* body = topLevel->functionExpr(i)->codeBlocksDecodingCached(vm).first)
                appendFunctionsOf(body);
        }
    }

    std::pair<unsigned, unsigned> ownRange { 0, sourceCode.length() ? sourceCode.length() - 1 : 0 };
    std::ranges::sort(functions);
    auto duplicates = std::ranges::unique(functions);
    functions.shrink(functions.size() - duplicates.size());
    functions.removeAll(ownRange);

    Vector<BasicBlockRange> ranges;
    ranges.reserveInitialCapacity(functions.size() + 1);
    auto append = [&](std::pair<unsigned, unsigned> function) {
        BasicBlockRange range;
        range.m_startOffset = static_cast<int>(function.first);
        range.m_endOffset = static_cast<int>(function.second);
        range.m_hasExecuted = false;
        range.m_executionCount = 0;
        ranges.append(range);
    };
    append(ownRange);
    for (auto& function : functions)
        append(function);

    callback(ctx, ranges.begin(), ranges.size());
    return true;
}
