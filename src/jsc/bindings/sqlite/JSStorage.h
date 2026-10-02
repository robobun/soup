// The Web Storage API: the `Storage` interface behind `localStorage` and `sessionStorage`.
// https://html.spec.whatwg.org/multipage/webstorage.html
//
// Items are kept in SQLite, in the schema Node.js uses (src/node_webstorage.cc), so the file
// that `--localstorage-file` names can be shared with other processes, Node.js ones included.
// `sessionStorage` is the same code on an in-memory database. Like node:sqlite, this goes
// through the one SQLite library the process loads (see NodeSqlite.h).
#pragma once

#include "root.h"
#include "BunClientData.h"
#include <JavaScriptCore/JSDestructibleObject.h>
#include <JavaScriptCore/InternalFunction.h>
#include <wtf/StdLibExtras.h>
#include <wtf/Vector.h>
#include <wtf/text/WTFString.h>
#include <array>
#include <expected>

extern "C" {
struct sqlite3;
struct sqlite3_stmt;
}

namespace Bun {

// Why an operation on the database failed, for the caller to throw (or, in a lookup that must
// not throw, to drop).
struct StorageError {
    enum class Kind : uint8_t {
        // DOMException QuotaExceededError
        QuotaExceeded,
        // ERR_INVALID_STATE, as in Node.js
        InvalidState,
        // The SQLite library could not be loaded.
        Library,
    };
    Kind kind;
    WTF::String message;
};

template<typename T> using StorageResult = std::expected<T, StorageError>;

class JSStorage final : public JSC::JSDestructibleObject {
public:
    using Base = JSC::JSDestructibleObject;
    static constexpr JSC::DestructionMode needsDestruction = NeedsDestruction;
    // What WebKit's bindings generator gives an interface with a named getter, setter and
    // deleter. No lookup on this object may be cached: another process can change the answer.
    static constexpr unsigned StructureFlags = Base::StructureFlags
        | JSC::GetOwnPropertySlotIsImpureForPropertyAbsence
        | JSC::InterceptsGetOwnPropertySlotByIndexEvenWhenLengthIsNotZero
        | JSC::OverridesGetOwnPropertyNames
        | JSC::OverridesGetOwnPropertySlot
        | JSC::OverridesPut
        | JSC::ProhibitsPropertyCaching;

    DECLARE_INFO;

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        // An index is the key of an item like any other string. This is what tells the array
        // functions so, for an array that has a storage in its prototype chain.
        return Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::ObjectType, StructureFlags), info(), JSC::MayHaveIndexedAccessors);
    }

    // `location` is what SQLite opens: an absolute path, or ":memory:".
    static JSStorage* create(JSC::VM&, JSC::Structure*, WTF::String&& location);

    template<typename, JSC::SubspaceAccess mode> static JSC::GCClient::IsoSubspace* subspaceFor(JSC::VM& vm)
    {
        if constexpr (mode == JSC::SubspaceAccess::Concurrently)
            return nullptr;
        return subspaceForImpl(vm);
    }
    static JSC::GCClient::IsoSubspace* subspaceForImpl(JSC::VM&);

    static void destroy(JSC::JSCell* cell) { static_cast<JSStorage*>(cell)->~JSStorage(); }
    ~JSStorage();

    StorageResult<uint32_t> length();
    // The null string when there is no such item.
    StorageResult<WTF::String> key(uint32_t index);
    StorageResult<WTF::String> getItem(const WTF::String& key);
    StorageResult<void> setItem(const WTF::String& key, const WTF::String& value);
    StorageResult<void> removeItem(const WTF::String& key);
    StorageResult<void> clear();
    StorageResult<WTF::Vector<WTF::String>> keys();
    // The database is opened again by the next operation.
    void close();

    static bool getOwnPropertySlot(JSC::JSObject*, JSC::JSGlobalObject*, JSC::PropertyName, JSC::PropertySlot&);
    static bool getOwnPropertySlotByIndex(JSC::JSObject*, JSC::JSGlobalObject*, unsigned, JSC::PropertySlot&);
    static void getOwnPropertyNames(JSC::JSObject*, JSC::JSGlobalObject*, JSC::PropertyNameArrayBuilder&, JSC::DontEnumPropertiesMode);
    static bool put(JSC::JSCell*, JSC::JSGlobalObject*, JSC::PropertyName, JSC::JSValue, JSC::PutPropertySlot&);
    static bool putByIndex(JSC::JSCell*, JSC::JSGlobalObject*, unsigned, JSC::JSValue, bool shouldThrow);
    static bool defineOwnProperty(JSC::JSObject*, JSC::JSGlobalObject*, JSC::PropertyName, const JSC::PropertyDescriptor&, bool shouldThrow);
    static bool deleteProperty(JSC::JSCell*, JSC::JSGlobalObject*, JSC::PropertyName, JSC::DeletePropertySlot&);
    static bool deletePropertyByIndex(JSC::JSCell*, JSC::JSGlobalObject*, unsigned);
    static bool preventExtensions(JSC::JSObject*, JSC::JSGlobalObject*);

private:
    enum class Statement : uint8_t {
        Length,
        Key,
        Get,
        Set,
        Remove,
        Clear,
        Keys,
    };
    static constexpr size_t statementCount = 7;

    JSStorage(JSC::VM& vm, JSC::Structure* structure, WTF::String&& location)
        : Base(vm, structure)
        , m_location(WTF::move(location))
    {
    }

    void finishCreation(JSC::VM&);
    StorageResult<void> open();
    StorageResult<sqlite3_stmt*> statement(Statement);

    sqlite3* m_db { nullptr };
    std::array<sqlite3_stmt*, statementCount> m_statements {};
    WTF::String m_location;
};

class JSStoragePrototype final : public JSC::JSNonFinalObject {
public:
    using Base = JSC::JSNonFinalObject;
    DECLARE_INFO;

    static JSStoragePrototype* create(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::Structure* structure)
    {
        auto* ptr = new (NotNull, Bun::allocatePlainObjectCell(vm, sizeof(JSStoragePrototype))) JSStoragePrototype(vm, structure);
        ptr->finishCreation(vm, globalObject);
        return ptr;
    }

    template<typename CellType, JSC::SubspaceAccess>
    static JSC::GCClient::IsoSubspace* subspaceFor(JSC::VM& vm)
    {
        STATIC_ASSERT_ISO_SUBSPACE_SHARABLE(JSStoragePrototype, Base);
        return &vm.plainObjectSpace();
    }

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        return Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::ObjectType, StructureFlags), info());
    }

private:
    JSStoragePrototype(JSC::VM& vm, JSC::Structure* structure)
        : Base(vm, structure)
    {
    }
    void finishCreation(JSC::VM&, JSC::JSGlobalObject*);
};

class JSStorageConstructor final : public JSC::InternalFunction {
public:
    using Base = JSC::InternalFunction;
    DECLARE_INFO;

    static constexpr unsigned StructureFlags = Base::StructureFlags;

    static JSStorageConstructor* create(JSC::VM&, JSC::JSGlobalObject*, JSC::Structure*, JSC::JSObject* prototype);

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        return Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::InternalFunctionType, StructureFlags), info());
    }

    static JSC::EncodedJSValue JSC_HOST_CALL_ATTRIBUTES call(JSC::JSGlobalObject*, JSC::CallFrame*);
    static JSC::EncodedJSValue JSC_HOST_CALL_ATTRIBUTES construct(JSC::JSGlobalObject*, JSC::CallFrame*);

private:
    JSStorageConstructor(JSC::VM& vm, JSC::Structure* structure)
        : Base(vm, structure, call, construct)
    {
    }
    void finishCreation(JSC::VM&, JSC::JSGlobalObject*, JSC::JSObject* prototype);
};

// The value of `--localstorage-file`: an absolute path or ":memory:", null when the flag was
// not given.
WTF::String localStorageFile();

} // namespace Bun
