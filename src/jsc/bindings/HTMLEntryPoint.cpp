#include "root.h"

#include "JavaScriptCore/CallData.h"
#include <JavaScriptCore/ObjectConstructor.h>
#include "InternalModuleRegistry.h"
#include "ModuleLoader.h"
#include "ZigGlobalObject.h"
#include <JavaScriptCore/JSPromise.h>
namespace Bun {
using namespace JSC;

// Mirrors `BuiltinEntryPoint` in VirtualMachine.rs.
enum class BuiltinEntryPoint : uint8_t {
    None = 0,
    // `bun ./index.html`
    Html = 1,
    // `bun serve`
    StaticServer = 2,
};

// The entry point is a builtin module. Its default export is the function that starts it.
extern "C" JSPromise* Bun__loadBuiltinEntryPoint(Zig::GlobalObject* globalObject, BuiltinEntryPoint entryPoint)
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    auto id = InternalModuleRegistry::InternalHtml;
    auto failureMessage = "Failed to load HTML entry point"_s;
    if (entryPoint == BuiltinEntryPoint::StaticServer) {
        id = InternalModuleRegistry::InternalStaticServer;
        failureMessage = "Failed to load the static file server"_s;
    }

    JSValue entryModule = globalObject->internalModuleRegistry()->requireId(globalObject, vm, id);
    if (scope.exception()) [[unlikely]] {
        return JSPromise::rejectedPromiseWithCaughtException(globalObject, scope);
    }

    JSObject* entryModuleObject = entryModule.getObject();
    if (!entryModuleObject) [[unlikely]] {
        Bun__panic(failureMessage.characters(), failureMessage.length());
    }

    MarkedArgumentBuffer args;
    JSValue result = JSC::call(globalObject, entryModuleObject, args, failureMessage);
    if (scope.exception()) [[unlikely]] {
        return JSPromise::rejectedPromiseWithCaughtException(globalObject, scope);
    }

    if (result.isUndefined()) {
        RELEASE_AND_RETURN(scope, JSPromise::resolvedPromise(globalObject, result));
    }

    JSPromise* promise = dynamicDowncast<JSC::JSPromise>(result);
    if (!promise) [[unlikely]] {
        Bun__panic(failureMessage.characters(), failureMessage.length());
    }
    return promise;
}

}
