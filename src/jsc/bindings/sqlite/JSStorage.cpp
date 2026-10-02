// The one SQLite library of the process, as in NodeSqlite.cpp: the system libsqlite3 that is
// dlopen'd on macOS (LAZY_LOAD_SQLITE=1), the bundled amalgamation elsewhere.
#ifndef LAZY_LOAD_SQLITE
#define LAZY_LOAD_SQLITE 0
#endif

#if LAZY_LOAD_SQLITE
#include "lazy_sqlite3.h"
#else
#include "sqlite3_local.h"
#endif

#include "JSStorage.h"

#include "ZigGlobalObject.h"
#include "ErrorCode.h"
#include "JSDOMExceptionHandling.h"
#include "DOMIsoSubspaces.h"
#include "DOMClientIsoSubspaces.h"
#include "BunClientData.h"

#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSObjectInlines.h>
#include <JavaScriptCore/JSCellInlines.h>
#include <JavaScriptCore/PropertyNameArray.h>
#include <JavaScriptCore/SubspaceInlines.h>
#include <JavaScriptCore/TypeError.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringView.h>
#include <limits>

// Defined in JSSQLStatement.cpp: the sqlite3_config() calls that have to come before the first
// open of the process, whichever module does it.
extern "C" void Bun__initializeSQLite();

extern "C" BunString Bun__Node__getLocalStorageFile();

namespace Bun {

using namespace JSC;

WTF::String localStorageFile()
{
    BunString file = Bun__Node__getLocalStorageFile();
    if (file.isDead())
        return {};
    return file.transferToWTFString();
}

// Node.js's schema (init_sql_v0 in src/node_webstorage.cc), statement for statement: a file
// that one of the two runtimes made is the other's too. Keys and values are the UTF-16 code
// units of the strings, as blobs, so that a lone surrogate survives. The triggers keep the
// size of all items in `total_size` and fail the statement that takes it past `max_size`.
// Node.js also runs `PRAGMA optimize` here. It is not part of the schema, and the ANALYZE it
// can start does not wait for another connection that writes: the open would fail at once.
static constexpr auto initSQL = "PRAGMA encoding = 'UTF-16le';"
                                "PRAGMA busy_timeout = 3000;"
                                "PRAGMA journal_mode = WAL;"
                                "PRAGMA synchronous = NORMAL;"
                                "PRAGMA temp_store = memory;"
                                "CREATE TABLE IF NOT EXISTS nodejs_webstorage("
                                "  key BLOB NOT NULL,"
                                "  value BLOB NOT NULL,"
                                "  PRIMARY KEY(key)"
                                ") STRICT;"
                                "CREATE TABLE IF NOT EXISTS nodejs_webstorage_state("
                                "  max_size INTEGER NOT NULL DEFAULT 10485760,"
                                "  total_size INTEGER NOT NULL,"
                                "  schema_version INTEGER NOT NULL DEFAULT 0,"
                                "  single_row_ INTEGER NOT NULL DEFAULT 1 CHECK(single_row_ = 1),"
                                "  PRIMARY KEY(single_row_)"
                                ") STRICT;"
                                "CREATE TRIGGER IF NOT EXISTS nodejs_quota_insert "
                                "AFTER INSERT ON nodejs_webstorage "
                                "FOR EACH ROW "
                                "BEGIN "
                                "  UPDATE nodejs_webstorage_state"
                                "    SET total_size = total_size + OCTET_LENGTH(NEW.key) +"
                                "      OCTET_LENGTH(NEW.value);"
                                "  SELECT RAISE(ABORT, 'QuotaExceeded') WHERE EXISTS ("
                                "    SELECT 1 FROM nodejs_webstorage_state WHERE total_size > max_size"
                                "  );"
                                "END;"
                                "CREATE TRIGGER IF NOT EXISTS nodejs_quota_update "
                                "AFTER UPDATE ON nodejs_webstorage "
                                "FOR EACH ROW "
                                "BEGIN "
                                "  UPDATE nodejs_webstorage_state"
                                "    SET total_size = total_size + "
                                "      ((OCTET_LENGTH(NEW.key) + OCTET_LENGTH(NEW.value)) -"
                                "      (OCTET_LENGTH(OLD.key) + OCTET_LENGTH(OLD.value)));"
                                "  SELECT RAISE(ABORT, 'QuotaExceeded') WHERE EXISTS ("
                                "    SELECT 1 FROM nodejs_webstorage_state WHERE total_size > max_size"
                                "  );"
                                "END;"
                                "CREATE TRIGGER IF NOT EXISTS nodejs_quota_delete "
                                "AFTER DELETE ON nodejs_webstorage "
                                "FOR EACH ROW "
                                "BEGIN "
                                "  UPDATE nodejs_webstorage_state"
                                "    SET total_size = total_size - (OCTET_LENGTH(OLD.key) +"
                                "      OCTET_LENGTH(OLD.value));"
                                "END;"
                                "INSERT OR IGNORE INTO nodejs_webstorage_state (total_size) VALUES (0);"_s;

static constexpr int currentSchemaVersion = 1;

// In the order of JSStorage::Statement.
static constexpr std::array<ASCIILiteral, 7> statementSQL = {
    "SELECT count(*) FROM nodejs_webstorage"_s,
    "SELECT key FROM nodejs_webstorage LIMIT 1 OFFSET ?"_s,
    "SELECT value FROM nodejs_webstorage WHERE key = ? LIMIT 1"_s,
    "INSERT INTO nodejs_webstorage (key, value) VALUES (?, ?)"
    "  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    "  WHERE EXCLUDED.key = key"_s,
    "DELETE FROM nodejs_webstorage WHERE key = ?"_s,
    "DELETE FROM nodejs_webstorage"_s,
    "SELECT key FROM nodejs_webstorage"_s,
};

static constexpr auto quotaExceededMessage = "Setting the value exceeded the quota"_s;

static constexpr int busyTimeoutMilliseconds = 3000;

// To be called before anything else is done with the connection: sqlite3_errmsg() is about
// its last call, and says which table or function where sqlite3_errstr() names the code.
static StorageError sqliteError(sqlite3* db, int code)
{
    return { StorageError::Kind::InvalidState, WTF::String::fromUTF8(db ? sqlite3_errmsg(db) : sqlite3_errstr(code)) };
}

// The file is the user's and the tables are made with IF NOT EXISTS, so what is in them is
// input: a file that has tables of these names with other types in them is an error to report.
static StorageError malformed(ASCIILiteral detail)
{
    return { StorageError::Kind::InvalidState, makeString("localStorage database is malformed: "_s, detail) };
}

static void throwStorageError(JSGlobalObject* globalObject, ThrowScope& scope, StorageError&& error)
{
    switch (error.kind) {
    case StorageError::Kind::QuotaExceeded:
        // A property hook is given the global object of the script that runs, which in a
        // node:vm context is not one that has the DOMException structures.
        WebCore::propagateException(*defaultGlobalObject(globalObject), scope, WebCore::Exception { WebCore::ExceptionCode::QuotaExceededError, WTF::move(error.message) });
        return;
    case StorageError::Kind::InvalidState:
        Bun::throwError(globalObject, scope, ErrorCode::ERR_INVALID_STATE, error.message);
        return;
    case StorageError::Kind::Library:
        throwException(globalObject, scope, createError(globalObject, error.message));
        return;
    }
}

// OCTET_LENGTH(), which the quota triggers call, came with SQLite 3.43. Where the library is
// the system's it can be older (macOS 13 has 3.39), and there the connection is given one. A
// trigger finds a function when it first runs, so the schema is the same text either way.
static void octetLength(sqlite3_context* context, int, sqlite3_value** arguments)
{
    if (sqlite3_value_type(arguments[0]) == SQLITE_NULL) {
        sqlite3_result_null(context);
        return;
    }
    sqlite3_result_int64(context, sqlite3_value_bytes(arguments[0]));
}

static bool libraryHasOctetLength()
{
    const char* cursor = sqlite3_libversion();
    auto number = [&] {
        int value = 0;
        while (*cursor >= '0' && *cursor <= '9')
            value = value * 10 + (*cursor++ - '0');
        return value;
    };
    int major = number();
    if (*cursor == '.')
        cursor++;
    int minor = number();
    return major > 3 || (major == 3 && minor >= 43);
}

// Puts a statement back when the operation that ran it is done. A statement that was stepped
// and not reset keeps its read transaction, and with it the snapshot: what other processes
// write would not be seen. The bindings point into the caller's strings.
class StatementScope {
public:
    explicit StatementScope(sqlite3_stmt* statement)
        : m_statement(statement)
    {
    }
    ~StatementScope()
    {
        sqlite3_reset(m_statement);
        sqlite3_clear_bindings(m_statement);
    }

private:
    sqlite3_stmt* m_statement;
};

// SQLite binds a null pointer as NULL whatever the length is, and the empty string is a key
// and a value like any other.
static int bindString(sqlite3_stmt* statement, int index, std::span<const char16_t> characters)
{
    static constexpr char16_t empty = 0;
    const char16_t* data = characters.empty() ? &empty : characters.data();
    return sqlite3_bind_blob(statement, index, data, static_cast<int>(characters.size_bytes()), SQLITE_STATIC);
}

static StorageResult<WTF::String> columnString(sqlite3_stmt* statement, ASCIILiteral detail)
{
    if (sqlite3_column_type(statement, 0) != SQLITE_BLOB)
        return makeUnexpected(malformed(detail));
    const void* blob = sqlite3_column_blob(statement, 0);
    size_t length = static_cast<size_t>(sqlite3_column_bytes(statement, 0)) / sizeof(char16_t);
    if (!length)
        return emptyString();
    // A blob can start at an odd address of a database page.
    Vector<char16_t, 128> characters(length);
    memcpy(characters.mutableSpan().data(), blob, length * sizeof(char16_t));
    return WTF::String { StringImpl::create8BitIfPossible(characters.span()) };
}

// sqlite3_bind_blob() takes the length as an `int`. The quota is far below that, so a longer
// string is over the quota without asking SQLite, and is the key of no item.
static bool fitsInBlob(const WTF::String& string)
{
    return string.length() <= static_cast<unsigned>(std::numeric_limits<int>::max()) / sizeof(char16_t);
}

// The databases that are open, for the exit of their VM.
static WTF::Lock openStoragesLock;
static WTF::HashMap<JSStorage*, JSC::VM*>& openStorages()
{
    static NeverDestroyed<WTF::HashMap<JSStorage*, JSC::VM*>> map;
    return map;
}

const ClassInfo JSStorage::s_info = { "Storage"_s, &Base::s_info, nullptr, nullptr, CREATE_METHOD_TABLE(JSStorage) };

JSStorage* JSStorage::create(VM& vm, Structure* structure, WTF::String&& location)
{
    auto* ptr = new (NotNull, allocateCell<JSStorage>(vm)) JSStorage(vm, structure, WTF::move(location));
    ptr->finishCreation(vm);
    return ptr;
}

void JSStorage::finishCreation(VM& vm)
{
    Base::finishCreation(vm);
    ASSERT(inherits(info()));
}

JSStorage::~JSStorage()
{
    close();
}

GCClient::IsoSubspace* JSStorage::subspaceForImpl(VM& vm)
{
    return WebCore::subspaceForImpl<JSStorage, WebCore::UseCustomHeapCellType::No>(vm, BUN_SUBSPACE_SLOTS(m_clientSubspaceForStorage, m_subspaceForStorage));
}

void JSStorage::close()
{
    if (!m_db)
        return;
    for (auto*& statement : m_statements) {
        sqlite3_finalize(statement);
        statement = nullptr;
    }
    // With no statement left this closes the connection now. The last connection to a file
    // checkpoints it and removes the -wal and -shm files.
    sqlite3_close_v2(m_db);
    m_db = nullptr;
    Locker locker { openStoragesLock };
    openStorages().remove(this);
}

StorageResult<void> JSStorage::open()
{
    if (m_db)
        return {};

#if LAZY_LOAD_SQLITE
    WTF::String message;
    if (lazyLoadSQLite(&message) < 0) [[unlikely]]
        return makeUnexpected(StorageError { StorageError::Kind::Library, WTF::move(message) });
#endif
    Bun__initializeSQLite();

    sqlite3* db = nullptr;
    auto location = m_location.utf8();
    int result = sqlite3_open_v2(location.legacyCStringPointer(), &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nullptr);
    // sqlite3_open_v2() makes a connection that has to be closed when it fails, too.
    auto fail = [&](StorageError&& error) -> StorageResult<void> {
        sqlite3_close_v2(db);
        return makeUnexpected(WTF::move(error));
    };
    if (result != SQLITE_OK)
        return fail(sqliteError(db, result));

#if LAZY_LOAD_SQLITE
    // Apple's SQLite keeps the -wal and -shm files after the last close unless it is told not to.
    int persistWAL = 0;
    sqlite3_file_control(db, nullptr, SQLITE_FCNTL_PERSIST_WAL, &persistWAL);
#endif

    if (!libraryHasOctetLength()) {
        result = sqlite3_create_function_v2(db, "octet_length", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC | SQLITE_INNOCUOUS, nullptr, octetLength, nullptr, nullptr, nullptr);
        if (result != SQLITE_OK)
            return fail(sqliteError(db, result));
    }

    // The switch of a new file to WAL does not wait for another process that is doing the
    // same, whatever the busy timeout is. Every statement of initSQL can run again.
    static constexpr int retryMilliseconds = 10;
    for (int waited = 0;; waited += retryMilliseconds) {
        result = sqlite3_exec(db, initSQL.characters(), nullptr, nullptr, nullptr);
        if ((result != SQLITE_BUSY && result != SQLITE_LOCKED) || waited >= busyTimeoutMilliseconds)
            break;
        sqlite3_sleep(retryMilliseconds);
    }
    if (result != SQLITE_OK)
        return fail(sqliteError(db, result));

    int64_t schemaVersion = 0;
    {
        static constexpr auto sql = "SELECT schema_version FROM nodejs_webstorage_state"_s;
        sqlite3_stmt* statement = nullptr;
        result = sqlite3_prepare_v2(db, sql.characters(), static_cast<int>(sql.length()), &statement, nullptr);
        if (result == SQLITE_OK)
            result = sqlite3_step(statement);
        bool isInteger = result == SQLITE_ROW && sqlite3_column_type(statement, 0) == SQLITE_INTEGER;
        if (isInteger)
            schemaVersion = sqlite3_column_int64(statement, 0);
        if (result != SQLITE_ROW) {
            auto error = sqliteError(db, result);
            sqlite3_finalize(statement);
            return fail(WTF::move(error));
        }
        sqlite3_finalize(statement);
        if (!isInteger)
            return fail(malformed("expected schema_version to be an integer"_s));
    }

    if (schemaVersion > currentSchemaVersion)
        return fail({ StorageError::Kind::InvalidState, "localStorage was created with a newer version of the schema than this version of Bun reads"_s });

    if (schemaVersion < currentSchemaVersion) {
        result = sqlite3_exec(db, "UPDATE nodejs_webstorage_state SET schema_version = 1;", nullptr, nullptr, nullptr);
        if (result != SQLITE_OK)
            return fail(sqliteError(db, result));
    }

    m_db = db;
    Locker locker { openStoragesLock };
    openStorages().set(this, &vm());
    return {};
}

StorageResult<sqlite3_stmt*> JSStorage::statement(Statement which)
{
    if (auto opened = open(); !opened) [[unlikely]]
        return makeUnexpected(WTF::move(opened.error()));

    auto& statement = m_statements[static_cast<size_t>(which)];
    if (!statement) {
        auto sql = statementSQL[static_cast<size_t>(which)];
        int result = sqlite3_prepare_v3(m_db, sql.characters(), static_cast<int>(sql.length()), SQLITE_PREPARE_PERSISTENT, &statement, nullptr);
        if (result != SQLITE_OK) [[unlikely]]
            return makeUnexpected(sqliteError(m_db, result));
    }
    return statement;
}

StorageResult<uint32_t> JSStorage::length()
{
    auto statement = this->statement(Statement::Length);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    int result = sqlite3_step(*statement);
    if (result != SQLITE_ROW)
        return makeUnexpected(sqliteError(m_db, result));
    return static_cast<uint32_t>(sqlite3_column_int64(*statement, 0));
}

StorageResult<WTF::String> JSStorage::key(uint32_t index)
{
    auto statement = this->statement(Statement::Key);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    int result = sqlite3_bind_int64(*statement, 1, index);
    if (result != SQLITE_OK)
        return makeUnexpected(sqliteError(m_db, result));
    result = sqlite3_step(*statement);
    if (result == SQLITE_DONE)
        return WTF::String();
    if (result != SQLITE_ROW)
        return makeUnexpected(sqliteError(m_db, result));
    return columnString(*statement, "expected key to be a blob"_s);
}

StorageResult<WTF::String> JSStorage::getItem(const WTF::String& key)
{
    if (!fitsInBlob(key)) [[unlikely]]
        return WTF::String();
    auto statement = this->statement(Statement::Get);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    auto keyCharacters = StringView(key).upconvertedCharacters();
    int result = bindString(*statement, 1, keyCharacters.span());
    if (result != SQLITE_OK)
        return makeUnexpected(sqliteError(m_db, result));
    result = sqlite3_step(*statement);
    if (result == SQLITE_DONE)
        return WTF::String();
    if (result != SQLITE_ROW)
        return makeUnexpected(sqliteError(m_db, result));
    return columnString(*statement, "expected value to be a blob"_s);
}

StorageResult<void> JSStorage::setItem(const WTF::String& key, const WTF::String& value)
{
    if (!fitsInBlob(key) || !fitsInBlob(value)) [[unlikely]]
        return makeUnexpected(StorageError { StorageError::Kind::QuotaExceeded, quotaExceededMessage });
    auto statement = this->statement(Statement::Set);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    auto keyCharacters = StringView(key).upconvertedCharacters();
    auto valueCharacters = StringView(value).upconvertedCharacters();
    int result = bindString(*statement, 1, keyCharacters.span());
    if (result == SQLITE_OK)
        result = bindString(*statement, 2, valueCharacters.span());
    if (result != SQLITE_OK)
        return makeUnexpected(sqliteError(m_db, result));
    result = sqlite3_step(*statement);
    // The RAISE(ABORT) of the quota triggers.
    if (result == SQLITE_CONSTRAINT)
        return makeUnexpected(StorageError { StorageError::Kind::QuotaExceeded, quotaExceededMessage });
    if (result != SQLITE_DONE)
        return makeUnexpected(sqliteError(m_db, result));
    return {};
}

StorageResult<void> JSStorage::removeItem(const WTF::String& key)
{
    if (!fitsInBlob(key)) [[unlikely]]
        return {};
    auto statement = this->statement(Statement::Remove);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    auto keyCharacters = StringView(key).upconvertedCharacters();
    int result = bindString(*statement, 1, keyCharacters.span());
    if (result != SQLITE_OK)
        return makeUnexpected(sqliteError(m_db, result));
    result = sqlite3_step(*statement);
    if (result != SQLITE_DONE)
        return makeUnexpected(sqliteError(m_db, result));
    return {};
}

StorageResult<void> JSStorage::clear()
{
    auto statement = this->statement(Statement::Clear);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    int result = sqlite3_step(*statement);
    if (result != SQLITE_DONE)
        return makeUnexpected(sqliteError(m_db, result));
    return {};
}

StorageResult<Vector<WTF::String>> JSStorage::keys()
{
    auto statement = this->statement(Statement::Keys);
    if (!statement)
        return makeUnexpected(WTF::move(statement.error()));
    StatementScope scope { *statement };

    Vector<WTF::String> keys;
    int result;
    while ((result = sqlite3_step(*statement)) == SQLITE_ROW) {
        auto key = columnString(*statement, "expected key to be a blob"_s);
        if (!key)
            return makeUnexpected(WTF::move(key.error()));
        keys.append(WTF::move(*key));
    }
    if (result != SQLITE_DONE)
        return makeUnexpected(sqliteError(m_db, result));
    return keys;
}

// A Storage is a legacy platform object (https://webidl.spec.whatwg.org/#es-legacy-platform-objects)
// with a named getter (getItem), setter (setItem) and deleter (removeItem). The overrides
// below start from what WebKit's bindings generator writes for such an interface
// (JSTestNamedSetterNoIdentifier.cpp in its tests) and differ from it in three places, each on
// purpose:
//  - put() gives every string to the setter. The generated one leaves a name alone that the
//    prototype chain has, the specification does not, and webstorage/set.window.js checks it.
//  - getOwnPropertyNames() leaves out the items that isShadowed(). The generated one lists
//    every item, also those that are not properties.
//  - isShadowed() comes before the item is read, not after: it is cheaper than a query.

static inline WTF::String propertyNameToString(PropertyName propertyName)
{
    ASSERT(!propertyName.isSymbol());
    return propertyName.uid();
}

// Steps 2 to 5 of https://webidl.spec.whatwg.org/#dfn-named-property-visibility: an item is
// not a property of the object when the object or its prototype chain has a property of that
// name, so `storage.getItem` is the method whatever is stored under "getItem". Step 1, whether
// the item exists, is the caller's and comes second there, because this part does not read
// the database.
//
// The walk up the prototype chain is a [[HasProperty]] and can run script: a Proxy that was
// made the prototype, or a lazy property of `Bun` or `process`, which is made by JavaScript.
// Only an inquiry of the VM's own, which must not, asks without.
static bool isShadowed(JSStorage* thisObject, JSGlobalObject* globalObject, PropertyName propertyName, bool isVMInquiry = false)
{
    auto& vm = JSC::getVM(globalObject);
    {
        PropertySlot slot { thisObject, PropertySlot::InternalMethodType::VMInquiry, &vm };
        if (JSObject::getOwnPropertySlot(thisObject, globalObject, propertyName, slot))
            return true;
    }
    JSValue prototype = thisObject->getPrototypeDirect();
    if (!prototype.isObject())
        return false;
    if (isVMInquiry) {
        PropertySlot slot { thisObject, PropertySlot::InternalMethodType::VMInquiry, &vm };
        return asObject(prototype)->getPropertySlot(globalObject, propertyName, slot);
    }
    PropertySlot slot { thisObject, PropertySlot::InternalMethodType::HasProperty };
    return asObject(prototype)->getPropertySlot(globalObject, propertyName, slot);
}

bool JSStorage::getOwnPropertySlot(JSObject* object, JSGlobalObject* globalObject, PropertyName propertyName, PropertySlot& slot)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* thisObject = uncheckedDowncast<JSStorage>(object);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    if (!propertyName.isSymbol()) {
        bool shadowed = isShadowed(thisObject, globalObject, propertyName, slot.isVMInquiry());
        RETURN_IF_EXCEPTION(scope, false);
        if (!shadowed) {
            auto value = thisObject->getItem(propertyNameToString(propertyName));
            if (!value) [[unlikely]] {
                // An inquiry of the VM's own does not throw.
                if (!slot.isVMInquiry())
                    throwStorageError(globalObject, scope, WTF::move(value.error()));
                return false;
            }
            if (!value->isNull()) {
                slot.setValue(thisObject, 0, jsString(vm, WTF::move(*value)));
                return true;
            }
        }
    }
    RELEASE_AND_RETURN(scope, JSObject::getOwnPropertySlot(object, globalObject, propertyName, slot));
}

bool JSStorage::getOwnPropertySlotByIndex(JSObject* object, JSGlobalObject* globalObject, unsigned index, PropertySlot& slot)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* thisObject = uncheckedDowncast<JSStorage>(object);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    auto propertyName = Identifier::from(vm, index);
    bool shadowed = isShadowed(thisObject, globalObject, propertyName, slot.isVMInquiry());
    RETURN_IF_EXCEPTION(scope, false);
    if (!shadowed) {
        auto value = thisObject->getItem(propertyName.string());
        if (!value) [[unlikely]] {
            if (!slot.isVMInquiry())
                throwStorageError(globalObject, scope, WTF::move(value.error()));
            return false;
        }
        if (!value->isNull()) {
            slot.setValue(thisObject, 0, jsString(vm, WTF::move(*value)));
            return true;
        }
    }
    RELEASE_AND_RETURN(scope, JSObject::getOwnPropertySlotByIndex(object, globalObject, index, slot));
}

void JSStorage::getOwnPropertyNames(JSObject* object, JSGlobalObject* globalObject, PropertyNameArrayBuilder& propertyNames, DontEnumPropertiesMode mode)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* thisObject = uncheckedDowncast<JSStorage>(object);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    auto keys = thisObject->keys();
    if (!keys) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(keys.error()));
        return;
    }
    for (auto& key : *keys) {
        auto propertyName = Identifier::fromString(vm, key);
        bool shadowed = isShadowed(thisObject, globalObject, propertyName);
        RETURN_IF_EXCEPTION(scope, void());
        if (!shadowed)
            propertyNames.add(propertyName);
    }
    RELEASE_AND_RETURN(scope, JSObject::getOwnPropertyNames(object, globalObject, propertyNames, mode));
}

// The named setter. https://webidl.spec.whatwg.org/#legacy-platform-object-set gives it every
// string, whatever the prototype chain has under that name.
static bool setNamedItem(JSStorage* thisObject, JSGlobalObject* globalObject, const WTF::String& key, JSValue value)
{
    auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
    auto string = value.toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, false);
    auto result = thisObject->setItem(key, string);
    if (!result) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(result.error()));
        return false;
    }
    return true;
}

bool JSStorage::put(JSCell* cell, JSGlobalObject* globalObject, PropertyName propertyName, JSValue value, PutPropertySlot& putPropertySlot)
{
    auto* thisObject = uncheckedDowncast<JSStorage>(cell);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    if (propertyName.isSymbol() || thisObject != putPropertySlot.thisValue()) [[unlikely]]
        return JSObject::put(thisObject, globalObject, propertyName, value, putPropertySlot);
    return setNamedItem(thisObject, globalObject, propertyNameToString(propertyName), value);
}

bool JSStorage::putByIndex(JSCell* cell, JSGlobalObject* globalObject, unsigned index, JSValue value, bool)
{
    auto* thisObject = uncheckedDowncast<JSStorage>(cell);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    return setNamedItem(thisObject, globalObject, WTF::String::number(index), value);
}

// https://webidl.spec.whatwg.org/#legacy-platform-object-defineownproperty
bool JSStorage::defineOwnProperty(JSObject* object, JSGlobalObject* globalObject, PropertyName propertyName, const PropertyDescriptor& descriptor, bool shouldThrow)
{
    auto* thisObject = uncheckedDowncast<JSStorage>(object);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    if (propertyName.isSymbol())
        return JSObject::defineOwnProperty(object, globalObject, propertyName, descriptor, shouldThrow);

    if (!descriptor.isDataDescriptor()) {
        auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
        return typeError(globalObject, scope, shouldThrow, "An item of a Storage can only be defined with a value"_s);
    }
    // `{ writable: false }` is a data descriptor that has no value. An item has no attributes
    // to change, and the "undefined" that the setter would make of no value is not what was
    // asked for: nothing happens, as in Node.js.
    if (!descriptor.value())
        return true;
    return setNamedItem(thisObject, globalObject, propertyNameToString(propertyName), descriptor.value());
}

// https://webidl.spec.whatwg.org/#legacy-platform-object-preventextensions: a storage cannot
// be frozen or sealed, because its items come and go whatever the object says.
bool JSStorage::preventExtensions(JSObject*, JSGlobalObject*)
{
    return false;
}

// The named deleter. https://webidl.spec.whatwg.org/#legacy-platform-object-delete: an item
// that is not there is deleted like a property that is not there, which is to say that
// nothing happens and the answer is true.
static bool deleteNamedItem(JSStorage* thisObject, JSGlobalObject* globalObject, const WTF::String& key)
{
    auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
    auto result = thisObject->removeItem(key);
    if (!result) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(result.error()));
        return false;
    }
    return true;
}

bool JSStorage::deleteProperty(JSCell* cell, JSGlobalObject* globalObject, PropertyName propertyName, DeletePropertySlot& slot)
{
    auto* thisObject = uncheckedDowncast<JSStorage>(cell);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    if (!propertyName.isSymbol()) {
        auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
        bool shadowed = isShadowed(thisObject, globalObject, propertyName);
        RETURN_IF_EXCEPTION(scope, false);
        if (!shadowed)
            RELEASE_AND_RETURN(scope, deleteNamedItem(thisObject, globalObject, propertyNameToString(propertyName)));
    }
    return JSObject::deleteProperty(cell, globalObject, propertyName, slot);
}

bool JSStorage::deletePropertyByIndex(JSCell* cell, JSGlobalObject* globalObject, unsigned index)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* thisObject = uncheckedDowncast<JSStorage>(cell);
    ASSERT_GC_OBJECT_INHERITS(thisObject, info());

    auto propertyName = Identifier::from(vm, index);
    bool shadowed = isShadowed(thisObject, globalObject, propertyName);
    RETURN_IF_EXCEPTION(scope, false);
    if (!shadowed)
        RELEASE_AND_RETURN(scope, deleteNamedItem(thisObject, globalObject, propertyName.string()));
    RELEASE_AND_RETURN(scope, JSObject::deletePropertyByIndex(cell, globalObject, index));
}

#define THIS_STORAGE()                                                                   \
    auto& vm = JSC::getVM(globalObject);                                                 \
    auto scope = DECLARE_THROW_SCOPE(vm);                                                \
    auto* self = dynamicDowncast<JSStorage>(callFrame->thisValue());                     \
    if (!self) [[unlikely]] {                                                            \
        throwInvalidThisError(globalObject, scope, callFrame->thisValue(), "Storage"_s); \
        return {};                                                                       \
    }

JSC_DEFINE_CUSTOM_GETTER(jsStorage_length, (JSGlobalObject * globalObject, EncodedJSValue thisValue, PropertyName))
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* self = dynamicDowncast<JSStorage>(JSValue::decode(thisValue));
    if (!self) [[unlikely]] {
        throwInvalidThisError(globalObject, scope, JSValue::decode(thisValue), "Storage"_s);
        return {};
    }
    auto length = self->length();
    if (!length) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(length.error()));
        return {};
    }
    return JSValue::encode(jsNumber(*length));
}

static inline EncodedJSValue toJSNullableString(VM& vm, const WTF::String& string)
{
    return JSValue::encode(string.isNull() ? jsNull() : jsString(vm, string));
}

JSC_DEFINE_HOST_FUNCTION(jsStoragePrototypeFunction_key, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    THIS_STORAGE();
    if (callFrame->argumentCount() < 1) [[unlikely]]
        return Bun::throwError(globalObject, scope, ErrorCode::ERR_MISSING_ARGS, "Failed to execute 'key' on 'Storage': 1 argument required"_s);
    // An `unsigned long`: 2 ** 32 is 0 and -1 is the largest index.
    uint32_t index = callFrame->uncheckedArgument(0).toUInt32(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto key = self->key(index);
    if (!key) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(key.error()));
        return {};
    }
    return toJSNullableString(vm, *key);
}

JSC_DEFINE_HOST_FUNCTION(jsStoragePrototypeFunction_getItem, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    THIS_STORAGE();
    if (callFrame->argumentCount() < 1) [[unlikely]]
        return Bun::throwError(globalObject, scope, ErrorCode::ERR_MISSING_ARGS, "Failed to execute 'getItem' on 'Storage': 1 argument required"_s);
    auto key = callFrame->uncheckedArgument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto value = self->getItem(key);
    if (!value) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(value.error()));
        return {};
    }
    return toJSNullableString(vm, *value);
}

JSC_DEFINE_HOST_FUNCTION(jsStoragePrototypeFunction_setItem, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    THIS_STORAGE();
    if (callFrame->argumentCount() < 2) [[unlikely]]
        return Bun::throwError(globalObject, scope, ErrorCode::ERR_MISSING_ARGS, "Failed to execute 'setItem' on 'Storage': 2 arguments required"_s);
    auto key = callFrame->uncheckedArgument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto value = callFrame->uncheckedArgument(1).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto result = self->setItem(key, value);
    if (!result) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(result.error()));
        return {};
    }
    return JSValue::encode(jsUndefined());
}

JSC_DEFINE_HOST_FUNCTION(jsStoragePrototypeFunction_removeItem, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    THIS_STORAGE();
    if (callFrame->argumentCount() < 1) [[unlikely]]
        return Bun::throwError(globalObject, scope, ErrorCode::ERR_MISSING_ARGS, "Failed to execute 'removeItem' on 'Storage': 1 argument required"_s);
    auto key = callFrame->uncheckedArgument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto result = self->removeItem(key);
    if (!result) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(result.error()));
        return {};
    }
    return JSValue::encode(jsUndefined());
}

JSC_DEFINE_HOST_FUNCTION(jsStoragePrototypeFunction_clear, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    THIS_STORAGE();
    auto result = self->clear();
    if (!result) [[unlikely]] {
        throwStorageError(globalObject, scope, WTF::move(result.error()));
        return {};
    }
    return JSValue::encode(jsUndefined());
}

#undef THIS_STORAGE

// The attributes and operations of an interface are enumerable.
static const HashTableValue JSStoragePrototypeTableValues[] = {
    { "length"_s, static_cast<unsigned>(JSC::PropertyAttribute::ReadOnly | JSC::PropertyAttribute::CustomAccessor), NoIntrinsic, { HashTableValue::GetterSetterType, jsStorage_length, 0 } },
    { "key"_s, static_cast<unsigned>(JSC::PropertyAttribute::Function), NoIntrinsic, { HashTableValue::NativeFunctionType, jsStoragePrototypeFunction_key, 1 } },
    { "getItem"_s, static_cast<unsigned>(JSC::PropertyAttribute::Function), NoIntrinsic, { HashTableValue::NativeFunctionType, jsStoragePrototypeFunction_getItem, 1 } },
    { "setItem"_s, static_cast<unsigned>(JSC::PropertyAttribute::Function), NoIntrinsic, { HashTableValue::NativeFunctionType, jsStoragePrototypeFunction_setItem, 2 } },
    { "removeItem"_s, static_cast<unsigned>(JSC::PropertyAttribute::Function), NoIntrinsic, { HashTableValue::NativeFunctionType, jsStoragePrototypeFunction_removeItem, 1 } },
    { "clear"_s, static_cast<unsigned>(JSC::PropertyAttribute::Function), NoIntrinsic, { HashTableValue::NativeFunctionType, jsStoragePrototypeFunction_clear, 0 } },
};

const ClassInfo JSStoragePrototype::s_info = { "Storage"_s, &Base::s_info, nullptr, nullptr, CREATE_METHOD_TABLE(JSStoragePrototype) };

void JSStoragePrototype::finishCreation(VM& vm, JSGlobalObject*)
{
    Base::finishCreation(vm);
    Bun::reifyStaticPropertyTable(vm, JSStorage::info(), JSStoragePrototypeTableValues, *this);
    Bun::putToStringTagWithoutTransition(vm, this, info());
}

const ClassInfo JSStorageConstructor::s_info = { "Storage"_s, &Base::s_info, nullptr, nullptr, CREATE_METHOD_TABLE(JSStorageConstructor) };

JSC_HOST_CALL_ATTRIBUTES EncodedJSValue JSStorageConstructor::call(JSGlobalObject* globalObject, CallFrame*)
{
    auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
    return Bun::throwError(globalObject, scope, ErrorCode::ERR_ILLEGAL_CONSTRUCTOR, "Illegal constructor"_s);
}

JSC_HOST_CALL_ATTRIBUTES EncodedJSValue JSStorageConstructor::construct(JSGlobalObject* globalObject, CallFrame*)
{
    auto scope = DECLARE_THROW_SCOPE(JSC::getVM(globalObject));
    return Bun::throwError(globalObject, scope, ErrorCode::ERR_ILLEGAL_CONSTRUCTOR, "Illegal constructor"_s);
}

JSStorageConstructor* JSStorageConstructor::create(VM& vm, JSGlobalObject* globalObject, Structure* structure, JSObject* prototype)
{
    auto* ptr = new (NotNull, allocateCell<JSStorageConstructor>(vm)) JSStorageConstructor(vm, structure);
    ptr->finishCreation(vm, globalObject, prototype);
    return ptr;
}

void JSStorageConstructor::finishCreation(VM& vm, JSGlobalObject*, JSObject* prototype)
{
    Base::finishCreation(vm, 0, "Storage"_s, PropertyAdditionMode::WithoutStructureTransition);
    putDirectWithoutTransition(vm, vm.propertyNames->prototype, prototype, PropertyAttribute::DontEnum | PropertyAttribute::DontDelete | PropertyAttribute::ReadOnly);
    ASSERT(inherits(info()));
}

} // namespace Bun

// The exit of a VM closes the databases it has open, which leaves a `--localstorage-file` as
// one file with everything in it. Another VM's are not touched: a Worker that still runs
// owns its own, and what it wrote is in the -wal file for the next open.
extern "C" void Bun__closeWebStorageForTermination(JSC::JSGlobalObject* globalObject)
{
    JSC::VM* exitingVM = &globalObject->vm();
    WTF::Vector<Bun::JSStorage*> toClose;
    {
        WTF::Locker locker { Bun::openStoragesLock };
        for (auto& entry : Bun::openStorages()) {
            if (entry.value == exitingVM)
                toClose.append(entry.key);
        }
    }
    for (auto* storage : toClose)
        storage->close();
}
