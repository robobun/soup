#include "root.h"

#include "FileReaderBinding.h"

#include "JSDOMException.h"
#include "JSDOMGlobalObjectInlines.h"
#include "JSEvent.h"
#include "JSEventTarget.h"
#include "ZigGlobalObject.h"
#include "node/NodeTimers.h"

#include <JavaScriptCore/JSFunction.h>
#include <JavaScriptCore/ObjectConstructor.h>

namespace Bun {

using namespace JSC;

// What src/js/internal/file_reader.ts is built on. The module loads when a program first reads
// `FileReader` or `ProgressEvent`, and that can be while a test library has its own `Event`,
// `EventTarget` or timers on the global object (happy-dom's registrator, a fake clock). These are
// the ones of the realm.
JSC::JSValue createFileReaderBinding(Zig::GlobalObject* globalObject)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);

    auto* binding = constructEmptyArray(globalObject, nullptr, 4);
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 0, WebCore::JSEvent::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 1, WebCore::JSEventTarget::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 2, WebCore::JSDOMException::getConstructor(vm, globalObject));
    RETURN_IF_EXCEPTION(scope, {});
    binding->putDirectIndex(globalObject, 3, JSFunction::create(vm, globalObject, 1, "setImmediate"_s, functionSetImmediate, ImplementationVisibility::Public));
    RETURN_IF_EXCEPTION(scope, {});

    return binding;
}

}
