#pragma once

#include "root.h"
#include "JavaScriptCore/LazyClassStructure.h"

namespace Bun {

// Bun.msgpack
JSC::JSValue constructMessagePackObject(JSC::VM&, JSC::JSObject* bunObject);

// Bun.msgpack.Extension
void setupMessagePackExtensionClassStructure(JSC::LazyClassStructure::Initializer&);

} // namespace Bun
