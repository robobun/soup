#include "root.h"

#include "EventSourceBinding.h"

#include "JSAbortController.h"
#include "JSDOMException.h"
#include "JSDOMGlobalObjectInlines.h"
#include "JSEvent.h"
#include "JSEventTarget.h"
#include "JSMessageEvent.h"
#include "ZigGlobalObject.h"

#include <JavaScriptCore/ObjectConstructor.h>

namespace Bun {

using namespace JSC;

// The classes that src/js/internal/event_source.ts is built on. The module loads when a program
// first reads `EventSource`, or requires "undici", and that can be while a test library has its own
// classes of these names on the global object (happy-dom's registrator). These are the ones of
// the realm.
JSC::JSValue createEventSourceBinding(Zig::GlobalObject* globalObject)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);

    auto* binding = constructEmptyArray(globalObject, nullptr, 5);
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 0, WebCore::JSEvent::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 1, WebCore::JSEventTarget::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 2, WebCore::JSMessageEvent::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 3, WebCore::JSDOMException::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 4, WebCore::JSAbortController::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});

    return binding;
}

}
