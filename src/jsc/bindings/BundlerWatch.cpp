#include "root.h"

#include "InternalModuleRegistry.h"
#include "ZigGlobalObject.h"
#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/JSCJSValueInlines.h>

namespace Bun {

using namespace JSC;

// `Bun.build({ watch: true })`. What builds again when a file changes is
// internal/build_watcher.ts; this returns its BuildWatcher for `config`.
extern "C" SYSV_ABI JSC::EncodedJSValue Bun__watchBuild(JSC::JSGlobalObject* lexicalGlobalObject, JSC::EncodedJSValue config)
{
    auto& vm = JSC::getVM(lexicalGlobalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* globalObject = defaultGlobalObject(lexicalGlobalObject);

    JSValue buildWatcher = globalObject->internalModuleRegistry()->requireId(globalObject, vm, InternalModuleRegistry::InternalBuildWatcher);
    RETURN_IF_EXCEPTION(scope, {});
    JSValue watch = buildWatcher.getObject()->get(globalObject, Identifier::fromString(vm, "watch"_s));
    RETURN_IF_EXCEPTION(scope, {});

    MarkedArgumentBuffer args;
    args.append(JSValue::decode(config));
    JSValue watcher = JSC::call(globalObject, watch, args, "Bun.build: watch is not a function"_s);
    // An invalid config throws from the first build, which the watcher starts as it is made.
    RETURN_IF_EXCEPTION(scope, {});
    return JSValue::encode(watcher);
}

} // namespace Bun
