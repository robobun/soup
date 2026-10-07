// Bun.msgpack: MessagePack (https://github.com/msgpack/msgpack/blob/master/spec.md).

#include "root.h"

#include "BunMessagePack.h"
#include "BunBuiltinNames.h"
#include "BunClientData.h"
#include "ZigGlobalObject.h"

#include <JavaScriptCore/ArrayConstructor.h>
#include <JavaScriptCore/BigIntObject.h>
#include <JavaScriptCore/BooleanObject.h>
#include <JavaScriptCore/DateInstance.h>
#include <JavaScriptCore/FunctionPrototype.h>
#include <JavaScriptCore/InternalFunction.h>
#include <JavaScriptCore/JSArray.h>
#include <JavaScriptCore/JSArrayBuffer.h>
#include <JavaScriptCore/JSArrayBufferViewInlines.h>
#include <JavaScriptCore/JSArrayInlines.h>
#include <JavaScriptCore/JSBigInt.h>
#include <JavaScriptCore/JSBigIntInlines.h>
#include <JavaScriptCore/JSCInlines.h>
#include <JavaScriptCore/JSGenericTypedArrayViewInlines.h>
#include <JavaScriptCore/JSMap.h>
#include <JavaScriptCore/JSMapInlines.h>
#include <JavaScriptCore/JSMapIterator.h>
#include <JavaScriptCore/JSONCacheInlines.h>
#include <JavaScriptCore/JSSet.h>
#include <JavaScriptCore/JSSetInlines.h>
#include <JavaScriptCore/JSSetIterator.h>
#include <JavaScriptCore/JSTypedArrays.h>
#include <JavaScriptCore/LazyClassStructureInlines.h>
#include <JavaScriptCore/NumberObject.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <JavaScriptCore/ObjectConstructorInlines.h>
#include <JavaScriptCore/PropertyNameArray.h>
#include <JavaScriptCore/StringObject.h>
#include <JavaScriptCore/StructureInlines.h>
#include <JavaScriptCore/StructureRareDataInlines.h>
#include <wtf/FastMalloc.h>
#include <wtf/FlipBytes.h>
#include <wtf/SharedTask.h>
#include <wtf/SIMDUTF.h>
#include <wtf/unicode/UTF8Conversion.h>

namespace Bun {

using namespace JSC;

namespace MessagePack {

enum Format : uint8_t {
    FixMap = 0x80,
    FixArray = 0x90,
    FixStr = 0xa0,
    Nil = 0xc0,
    NeverUsed = 0xc1,
    False = 0xc2,
    True = 0xc3,
    Bin8 = 0xc4,
    Bin16 = 0xc5,
    Bin32 = 0xc6,
    Ext8 = 0xc7,
    Ext16 = 0xc8,
    Ext32 = 0xc9,
    Float32 = 0xca,
    Float64 = 0xcb,
    Uint8 = 0xcc,
    Uint16 = 0xcd,
    Uint32 = 0xce,
    Uint64 = 0xcf,
    Int8 = 0xd0,
    Int16 = 0xd1,
    Int32 = 0xd2,
    Int64 = 0xd3,
    FixExt1 = 0xd4,
    FixExt2 = 0xd5,
    FixExt4 = 0xd6,
    FixExt8 = 0xd7,
    FixExt16 = 0xd8,
    Str8 = 0xd9,
    Str16 = 0xda,
    Str32 = 0xdb,
    Array16 = 0xdc,
    Array32 = 0xdd,
    Map16 = 0xde,
    Map32 = 0xdf,
};

static constexpr int8_t timestampType = -1;
static constexpr int64_t maxSafeInteger = 9007199254740991;
// A Date holds 8.64e15 milliseconds on each side of 1970.
static constexpr int64_t maxDateSeconds = 8640000000000;
static constexpr uint32_t nanosecondsPerSecond = 1000000000;

// Where `type` and `data` are in an object made by `new Extension()`.
static constexpr PropertyOffset extensionTypeOffset = 0;
static constexpr PropertyOffset extensionDataOffset = 1;

template<typename T>
static ALWAYS_INLINE void storeBigEndian(uint8_t* destination, T value)
{
#if CPU(LITTLE_ENDIAN)
    value = flipBytes(value);
#endif
    memcpy(destination, &value, sizeof(T));
}

template<typename T>
static ALWAYS_INLINE T loadBigEndian(const uint8_t* source)
{
    T value;
    memcpy(&value, source, sizeof(T));
#if CPU(LITTLE_ENDIAN)
    value = flipBytes(value);
#endif
    return value;
}

static ALWAYS_INLINE bool isAllASCII(std::span<const uint8_t> bytes)
{
    // Most keys and many strings are shorter than the call costs.
    if (bytes.size() <= 32) {
        uint8_t bits = 0;
        for (uint8_t byte : bytes)
            bits |= byte;
        return !(bits & 0x80);
    }
    return simdutf::validate_ascii(reinterpret_cast<const char*>(bytes.data()), bytes.size());
}

// The bytes of an ArrayBufferView or of an ArrayBuffer. Those of a detached one are none.
static bool bytesOf(JSValue value, std::span<const uint8_t>& bytes)
{
    if (!value.isCell())
        return false;
    JSCell* cell = value.asCell();
    if (isTypedArrayTypeIncludingDataView(cell->type())) {
        bytes = uncheckedDowncast<JSArrayBufferView>(cell)->span();
        return true;
    }
    if (cell->type() == ArrayBufferType) {
        bytes = uncheckedDowncast<JSArrayBuffer>(cell)->impl()->span();
        return true;
    }
    return false;
}

static bool isDetached(JSValue value)
{
    JSCell* cell = value.asCell();
    if (cell->type() == ArrayBufferType)
        return uncheckedDowncast<JSArrayBuffer>(cell)->impl()->isDetached();
    return uncheckedDowncast<JSArrayBufferView>(cell)->isDetached();
}

// False with an exception.
static bool extensionTypeOf(JSGlobalObject* globalObject, ThrowScope& scope, JSValue value, int8_t& type)
{
    if (!value.isNumber()) {
        throwTypeError(globalObject, scope, "Extension type must be a number"_s);
        return false;
    }
    double number = value.asNumber();
    if (!(number >= -128 && number <= 127) || number != std::trunc(number)) {
        throwRangeError(globalObject, scope, makeString("Extension type must be an integer from -128 to 127, not "_s, number));
        return false;
    }
    type = static_cast<int8_t>(number);
    return true;
}

// ───────────────────────────── encode ─────────────────────────────

// A write that does not fit in memory or in a Uint8Array is dropped: callers check failed() where they can throw.
class ByteBuffer {
    WTF_MAKE_NONCOPYABLE(ByteBuffer);
    WTF_FORBID_HEAP_ALLOCATION;

public:
    static constexpr size_t maxSize = MAX_ARRAY_BUFFER_SIZE;

    ByteBuffer() = default;

    ~ByteBuffer()
    {
        if (m_data != m_inlineData)
            fastFree(m_data);
    }

    size_t size() const { return m_size; }
    bool failed() const { return m_failed; }
    std::span<const uint8_t> span() const LIFETIME_BOUND { return { m_data, m_size }; }
    uint8_t* data() LIFETIME_BOUND { return m_data; }

    // `count` more bytes at the end, or null.
    ALWAYS_INLINE uint8_t* extend(size_t count)
    {
        if (count > m_capacity - m_size) [[unlikely]] {
            if (!grow(count))
                return nullptr;
        }
        uint8_t* at = m_data + m_size;
        m_size += count;
        return at;
    }

    ALWAYS_INLINE void append(uint8_t byte)
    {
        if (uint8_t* at = extend(1))
            *at = byte;
    }

    void shrink(size_t size)
    {
        ASSERT(size <= m_size);
        m_size = size;
    }

    void fail() { m_failed = true; }

    // The bytes if they are on the heap, for the caller to fastFree(). Null if they are not.
    uint8_t* release()
    {
        if (m_data == m_inlineData)
            return nullptr;
        uint8_t* data = m_data;
        uint8_t* exact = nullptr;
        if (m_size < m_capacity && WTF::tryFastRealloc(data, m_size).getValue(exact))
            data = exact;
        m_data = m_inlineData;
        m_size = 0;
        m_capacity = sizeof(m_inlineData);
        return data;
    }

private:
    NEVER_INLINE bool grow(size_t count)
    {
        if (m_failed || count > maxSize - m_size) {
            m_failed = true;
            return false;
        }
        size_t capacity = std::min(maxSize, std::max(m_size + count, m_capacity * 2));
        uint8_t* data = nullptr;
        if (m_data == m_inlineData) {
            if (!tryFastMalloc(capacity).getValue(data)) {
                m_failed = true;
                return false;
            }
            memcpy(data, m_inlineData, m_size);
        } else if (!WTF::tryFastRealloc(m_data, capacity).getValue(data)) {
            m_failed = true;
            return false;
        }
        m_data = data;
        m_capacity = capacity;
        return true;
    }

    uint8_t* m_data { m_inlineData };
    size_t m_size { 0 };
    size_t m_capacity { sizeof(m_inlineData) };
    bool m_failed { false };
    uint8_t m_inlineData[1024];
};

class Encoder {
    WTF_MAKE_NONCOPYABLE(Encoder);
    WTF_FORBID_HEAP_ALLOCATION;

public:
    explicit Encoder(JSGlobalObject* globalObject)
        : m_globalObject(globalObject)
        , m_vm(globalObject->vm())
    {
        auto* zigGlobalObject = defaultGlobalObject(globalObject);
        m_extensionStructure = zigGlobalObject->m_JSMessagePackExtensionClassStructure.get(zigGlobalObject);
        m_extensionPrototype = zigGlobalObject->m_JSMessagePackExtensionClassStructure.prototype(zigGlobalObject);
    }

    // The value alone, not inside anything. An exception is thrown if it cannot be written.
    void writeRoot(JSValue);

    // What was written. Null with an exception.
    JSUint8Array* takeBytes();

private:
    // What toJSON() is told: the name of the property or the index of the element its object is at.
    struct Key {
        UniquedStringImpl* name { nullptr };
        uint32_t index { 0 };
        bool isIndex { false };

        static Key none() { return {}; }
        static Key named(UniquedStringImpl* name) { return { name, 0, false }; }
        static Key at(uint32_t index) { return { nullptr, index, true }; }

        JSValue toJS(VM& vm) const
        {
            if (isIndex)
                return jsString(vm, String::number(index));
            if (name)
                return jsString(vm, String(name));
            return jsEmptyString(vm);
        }
    };

    // Objects that are written as something other than their properties, so toJSON() is not asked.
    ALWAYS_INLINE bool hasFormatOfItsOwn(JSObject* object)
    {
        JSC::JSType type = object->type();
        switch (type) {
        case ArrayType:
        case DerivedArrayType:
        case ArrayBufferType:
        case JSDateType:
        case JSMapType:
        case JSSetType:
        case BooleanObjectType:
        case NumberObjectType:
        case StringObjectType:
        case DerivedStringObjectType:
            return true;
        case FinalObjectType:
            return isExtension(object);
        default:
            return isTypedArrayTypeIncludingDataView(type);
        }
    }

    ALWAYS_INLINE bool isExtension(JSObject* object)
    {
        ASSERT(object->type() == FinalObjectType);
        if (object->structure() == m_extensionStructure)
            return true;
        JSValue prototype = object->getPrototypeDirect();
        if (prototype == m_globalObject->objectPrototype()) [[likely]]
            return false;
        while (prototype.isObject()) {
            JSObject* prototypeObject = asObject(prototype);
            if (prototypeObject == m_extensionPrototype)
                return true;
            prototype = prototypeObject->getPrototypeDirect();
        }
        return false;
    }

    // What JSON.stringify leaves out of an object, and writes as null in an array.
    static ALWAYS_INLINE bool isOmitted(JSValue value)
    {
        if (value.isUndefined() || value.isSymbol())
            return true;
        return value.isObject() && asObject(value)->isCallable();
    }

    JSValue toJSON(JSValue, const Key&);

    // These take a value that toJSON() was already asked for.
    void write(JSValue);
    void writeObjectValue(JSObject*);

    void writeElement(JSValue, const Key&);
    bool writeProperty(UniquedStringImpl* name, JSValue);

    void writeString(JSString*);
    void writeString(StringView);
    void writeBigInt(JSValue);
    void writeBoxed(JSObject*);
    void writeBinary(std::span<const uint8_t>);
    void writeDate(DateInstance*);
    void writeExtension(JSObject*);
    void writeArray(JSObject*);
    void writeMap(JSMap*);
    void writeSet(JSSet*);
    void writeObject(JSObject*);

    uint32_t writeNumbers(JSObject* array, uint32_t length);

    bool enter(JSObject*);
    void leave() { m_holders.removeLast(); }
    // False with an exception if a write was dropped.
    bool checkBuffer(ThrowScope&);

    template<typename T>
    ALWAYS_INLINE void writeWithFormat(Format format, T value)
    {
        if (uint8_t* at = m_buffer.extend(1 + sizeof(T))) {
            at[0] = format;
            storeBigEndian(at + 1, value);
        }
    }

    ALWAYS_INLINE void writeUnsigned(uint64_t value)
    {
        if (value < 0x80)
            m_buffer.append(static_cast<uint8_t>(value));
        else if (value <= 0xff)
            writeWithFormat(Uint8, static_cast<uint8_t>(value));
        else if (value <= 0xffff)
            writeWithFormat(Uint16, static_cast<uint16_t>(value));
        else if (value <= 0xffffffff)
            writeWithFormat(Uint32, static_cast<uint32_t>(value));
        else
            writeWithFormat(Uint64, value);
    }

    ALWAYS_INLINE void writeInteger(int64_t value)
    {
        if (value >= 0)
            writeUnsigned(static_cast<uint64_t>(value));
        else if (value >= -32)
            m_buffer.append(static_cast<uint8_t>(value));
        else if (value >= std::numeric_limits<int8_t>::min())
            writeWithFormat(Int8, static_cast<uint8_t>(value));
        else if (value >= std::numeric_limits<int16_t>::min())
            writeWithFormat(Int16, static_cast<uint16_t>(value));
        else if (value >= std::numeric_limits<int32_t>::min())
            writeWithFormat(Int32, static_cast<uint32_t>(value));
        else
            writeWithFormat(Int64, static_cast<uint64_t>(value));
    }

    ALWAYS_INLINE void writeDouble(double value)
    {
        // An integer a double holds exactly is written as one. -0 is 0, as for JSON.stringify.
        if (value == std::trunc(value) && std::abs(value) <= static_cast<double>(maxSafeInteger)) {
            writeInteger(static_cast<int64_t>(value));
            return;
        }
        writeWithFormat(Float64, std::bit_cast<uint64_t>(value));
    }

    // Format with the length in the low bits when it is below `fixedLimit`, then `format16` and `format32`.
    ALWAYS_INLINE void writeLength(Format fixed, uint32_t fixedLimit, Format format16, Format format32, uint32_t length)
    {
        if (length < fixedLimit)
            m_buffer.append(static_cast<uint8_t>(fixed | length));
        else if (length <= 0xffff)
            writeWithFormat(format16, static_cast<uint16_t>(length));
        else
            writeWithFormat(format32, length);
    }

    ALWAYS_INLINE void writeArrayHeader(uint32_t length) { writeLength(FixArray, 16, Array16, Array32, length); }
    ALWAYS_INLINE void writeMapHeader(uint32_t length) { writeLength(FixMap, 16, Map16, Map32, length); }

    static ALWAYS_INLINE size_t mapHeaderSize(uint32_t length)
    {
        return length < 16 ? 1 : length <= 0xffff ? 3
                                                  : 5;
    }

    static ALWAYS_INLINE size_t stringHeaderSize(size_t length)
    {
        return length < 32 ? 1 : length <= 0xff ? 2
            : length <= 0xffff                  ? 3
                                                : 5;
    }

    // At `at`, where stringHeaderSize(length) bytes are.
    static ALWAYS_INLINE void writeStringHeader(uint8_t* at, size_t length)
    {
        if (length < 32)
            at[0] = static_cast<uint8_t>(FixStr | length);
        else if (length <= 0xff) {
            at[0] = Str8;
            at[1] = static_cast<uint8_t>(length);
        } else if (length <= 0xffff) {
            at[0] = Str16;
            storeBigEndian(at + 1, static_cast<uint16_t>(length));
        } else {
            at[0] = Str32;
            storeBigEndian(at + 1, static_cast<uint32_t>(length));
        }
    }

    JSGlobalObject* m_globalObject;
    VM& m_vm;
    Structure* m_extensionStructure;
    JSObject* m_extensionPrototype;
    ByteBuffer m_buffer;
    // What the value being written is inside of. One of these again is a cycle.
    Vector<JSObject*, 32> m_holders;
};

bool Encoder::checkBuffer(ThrowScope& scope)
{
    if (!m_buffer.failed()) [[likely]]
        return true;
    throwOutOfMemoryError(m_globalObject, scope);
    return false;
}

bool Encoder::enter(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    if (!vm.isSafeToRecurseSoft()) [[unlikely]] {
        throwStackOverflowError(m_globalObject, scope);
        return false;
    }
    for (JSObject* holder : m_holders) {
        if (holder == object) [[unlikely]] {
            throwTypeError(m_globalObject, scope, "Bun.msgpack.encode cannot serialize cyclic structures"_s);
            return false;
        }
    }
    m_holders.append(object);
    return true;
}

JSValue Encoder::toJSON(JSValue value, const Key& key)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    if (!value.isObject())
        return value;
    JSObject* object = asObject(value);
    if (hasFormatOfItsOwn(object))
        return value;

    JSValue function = object->structure()->cachedSpecialProperty(CachedSpecialPropertyKey::ToJSON);
    if (!function) {
        PropertySlot slot(object, PropertySlot::InternalMethodType::Get);
        bool hasProperty = object->getPropertySlot(m_globalObject, vm.propertyNames->toJSON, slot);
        RETURN_IF_EXCEPTION(scope, {});
        function = hasProperty ? slot.getValue(m_globalObject, vm.propertyNames->toJSON) : jsUndefined();
        RETURN_IF_EXCEPTION(scope, {});
        object->structure()->cacheSpecialProperty(m_globalObject, vm, function, CachedSpecialPropertyKey::ToJSON, slot);
    }

    auto callData = JSC::getCallData(function);
    if (callData.type == CallData::Type::None)
        return value;

    MarkedArgumentBuffer arguments;
    arguments.append(key.toJS(vm));
    ASSERT(!arguments.hasOverflowed());
    RELEASE_AND_RETURN(scope, call(m_globalObject, function, callData, object, arguments));
}

void Encoder::writeRoot(JSValue root)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSValue value = toJSON(root, Key::none());
    RETURN_IF_EXCEPTION(scope, void());

    if (value.isSymbol()) {
        throwTypeError(m_globalObject, scope, "Bun.msgpack.encode cannot encode a symbol"_s);
        return;
    }
    if (value.isObject() && asObject(value)->isCallable()) {
        throwTypeError(m_globalObject, scope, "Bun.msgpack.encode cannot encode a function"_s);
        return;
    }

    write(value);
    RETURN_IF_EXCEPTION(scope, void());
    checkBuffer(scope);
}

JSUint8Array* Encoder::takeBytes()
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    Structure* structure = m_globalObject->m_typedArrayUint8.get(m_globalObject);
    size_t size = m_buffer.size();
    if (uint8_t* bytes = m_buffer.release()) {
        auto buffer = ArrayBuffer::createFromBytes({ bytes, size }, createSharedTask<void(void*)>([](void* bytes) {
            fastFree(bytes);
        }));
        RELEASE_AND_RETURN(scope, JSUint8Array::create(m_globalObject, structure, WTF::move(buffer), 0, size));
    }

    auto* array = JSUint8Array::createUninitialized(m_globalObject, structure, size);
    RETURN_IF_EXCEPTION(scope, nullptr);
    memcpy(array->typedVector(), m_buffer.span().data(), size);
    return array;
}

inline void Encoder::write(JSValue value)
{
    if (value.isInt32()) {
        writeInteger(value.asInt32());
        return;
    }
    if (value.isDouble()) {
        writeDouble(value.asDouble());
        return;
    }
    if (value.isString()) {
        writeString(asString(value));
        return;
    }
    if (value.isBoolean()) {
        m_buffer.append(static_cast<uint8_t>(value.asBoolean() ? True : False));
        return;
    }
    if (value.isObject()) {
        writeObjectValue(asObject(value));
        return;
    }
    if (value.isBigInt()) {
        writeBigInt(value);
        return;
    }
    // null, undefined, and what else has no format.
    m_buffer.append(static_cast<uint8_t>(Nil));
}

void Encoder::writeObjectValue(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSC::JSType type = object->type();
    switch (type) {
    case ArrayType:
    case DerivedArrayType:
        RELEASE_AND_RETURN(scope, writeArray(object));
    case FinalObjectType:
        if (isExtension(object))
            RELEASE_AND_RETURN(scope, writeExtension(object));
        RELEASE_AND_RETURN(scope, writeObject(object));
    case ArrayBufferType:
        writeBinary(uncheckedDowncast<JSArrayBuffer>(object)->impl()->span());
        return;
    case JSDateType:
        writeDate(uncheckedDowncast<DateInstance>(object));
        return;
    case JSMapType:
        RELEASE_AND_RETURN(scope, writeMap(uncheckedDowncast<JSMap>(object)));
    case JSSetType:
        RELEASE_AND_RETURN(scope, writeSet(uncheckedDowncast<JSSet>(object)));
    case BooleanObjectType:
    case NumberObjectType:
    case StringObjectType:
    case DerivedStringObjectType:
        RELEASE_AND_RETURN(scope, writeBoxed(object));
    case ProxyObjectType: {
        bool isArray = JSC::isArray(m_globalObject, object);
        RETURN_IF_EXCEPTION(scope, void());
        if (isArray)
            RELEASE_AND_RETURN(scope, writeArray(object));
        RELEASE_AND_RETURN(scope, writeObject(object));
    }
    default:
        break;
    }
    if (isTypedArrayTypeIncludingDataView(type)) {
        writeBinary(uncheckedDowncast<JSArrayBufferView>(object)->span());
        return;
    }
    if (object->inherits<BigIntObject>())
        RELEASE_AND_RETURN(scope, writeBoxed(object));
    RELEASE_AND_RETURN(scope, writeObject(object));
}

void Encoder::writeString(JSString* string)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto view = string->view(m_globalObject);
    RETURN_IF_EXCEPTION(scope, void());
    writeString(view.data);
}

void Encoder::writeString(StringView string)
{
    size_t length = string.length();
    if (string.is8Bit()) {
        auto characters = string.span8();
        size_t start = m_buffer.size();
        size_t headerSize = stringHeaderSize(length);
        uint8_t* at = m_buffer.extend(headerSize + length);
        if (!at) [[unlikely]]
            return;
        writeStringHeader(at, length);
        memcpy(at + headerSize, characters.data(), length);
        if (isAllASCII({ at + headerSize, length })) [[likely]]
            return;

        // Latin-1 above ASCII: two bytes each.
        m_buffer.shrink(start);
        auto* latin1 = reinterpret_cast<const char*>(characters.data());
        size_t encodedLength = simdutf::utf8_length_from_latin1(latin1, length);
        if (encodedLength > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
            m_buffer.fail();
            return;
        }
        headerSize = stringHeaderSize(encodedLength);
        at = m_buffer.extend(headerSize + encodedLength);
        if (!at) [[unlikely]]
            return;
        writeStringHeader(at, encodedLength);
        size_t written = simdutf::convert_latin1_to_utf8(latin1, length, reinterpret_cast<char*>(at + headerSize));
        ASSERT_UNUSED(written, written == encodedLength);
        return;
    }

    // UTF-16 is converted after the longest header there is, then moved back to the header it needs.
    auto characters = string.span16();
    static constexpr size_t maxHeaderSize = 5;
    size_t start = m_buffer.size();
    size_t maxLength = length * 3;
    uint8_t* at = m_buffer.extend(maxHeaderSize + maxLength);
    if (!at) [[unlikely]]
        return;
    size_t encodedLength;
    auto converted = simdutf::convert_utf16le_to_utf8_with_errors(characters.data(), length, reinterpret_cast<char*>(at + maxHeaderSize));
    if (converted.error == simdutf::error_code::SUCCESS) [[likely]]
        encodedLength = converted.count;
    else {
        // A lone surrogate becomes U+FFFD, as for TextEncoder.
        auto replaced = WTF::Unicode::convertReplacingInvalidSequences(characters, std::span<char8_t> { reinterpret_cast<char8_t*>(at + maxHeaderSize), maxLength });
        ASSERT(replaced.code == WTF::Unicode::ConversionResultCode::Success);
        encodedLength = replaced.buffer.size();
    }
    if (encodedLength > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        m_buffer.fail();
        return;
    }
    size_t headerSize = stringHeaderSize(encodedLength);
    writeStringHeader(at, encodedLength);
    memmove(at + headerSize, at + maxHeaderSize, encodedLength);
    m_buffer.shrink(start + headerSize + encodedLength);
}

void Encoder::writeBigInt(JSValue value)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    if (JSBigInt::compare(value, static_cast<int64_t>(0)) == JSBigInt::ComparisonResult::LessThan) {
        if (JSBigInt::compare(value, std::numeric_limits<int64_t>::min()) == JSBigInt::ComparisonResult::LessThan) {
            throwRangeError(m_globalObject, scope, "Bun.msgpack.encode cannot encode a BigInt below -(2n ** 63n)"_s);
            return;
        }
        writeWithFormat(Int64, static_cast<uint64_t>(JSBigInt::toBigInt64(value)));
        return;
    }
    if (JSBigInt::compare(value, std::numeric_limits<uint64_t>::max()) == JSBigInt::ComparisonResult::GreaterThan) {
        throwRangeError(m_globalObject, scope, "Bun.msgpack.encode cannot encode a BigInt above 2n ** 64n - 1n"_s);
        return;
    }
    writeWithFormat(Uint64, static_cast<uint64_t>(JSBigInt::toBigUInt64(value)));
}

void Encoder::writeBoxed(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSValue primitive;
    if (object->inherits<NumberObject>())
        primitive = jsNumber(object->toNumber(m_globalObject));
    else if (object->inherits<StringObject>())
        primitive = object->toString(m_globalObject);
    else
        primitive = uncheckedDowncast<JSWrapperObject>(object)->internalValue();
    RETURN_IF_EXCEPTION(scope, void());
    RELEASE_AND_RETURN(scope, write(primitive));
}

void Encoder::writeBinary(std::span<const uint8_t> bytes)
{
    size_t length = bytes.size();
    if (length > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        m_buffer.fail();
        return;
    }
    if (length <= 0xff)
        writeWithFormat(Bin8, static_cast<uint8_t>(length));
    else if (length <= 0xffff)
        writeWithFormat(Bin16, static_cast<uint16_t>(length));
    else
        writeWithFormat(Bin32, static_cast<uint32_t>(length));
    if (!length)
        return;
    if (uint8_t* at = m_buffer.extend(length))
        memcpy(at, bytes.data(), length);
}

void Encoder::writeDate(DateInstance* date)
{
    double time = date->internalNumber();
    // JSON.stringify writes null for an invalid Date.
    if (std::isnan(time)) {
        m_buffer.append(static_cast<uint8_t>(Nil));
        return;
    }

    // The time value of a Date is a whole number of milliseconds.
    int64_t milliseconds = static_cast<int64_t>(time);
    int64_t seconds = milliseconds / 1000;
    int64_t remainder = milliseconds % 1000;
    if (remainder < 0) {
        remainder += 1000;
        seconds -= 1;
    }
    uint32_t nanoseconds = static_cast<uint32_t>(remainder) * 1000000;

    // The smallest of the three timestamp formats that holds it.
    if (seconds >= 0 && seconds < (1ll << 34)) {
        if (!nanoseconds && seconds <= std::numeric_limits<uint32_t>::max()) {
            if (uint8_t* at = m_buffer.extend(6)) {
                at[0] = FixExt4;
                at[1] = static_cast<uint8_t>(timestampType);
                storeBigEndian(at + 2, static_cast<uint32_t>(seconds));
            }
            return;
        }
        if (uint8_t* at = m_buffer.extend(10)) {
            at[0] = FixExt8;
            at[1] = static_cast<uint8_t>(timestampType);
            storeBigEndian(at + 2, (static_cast<uint64_t>(nanoseconds) << 34) | static_cast<uint64_t>(seconds));
        }
        return;
    }
    if (uint8_t* at = m_buffer.extend(15)) {
        at[0] = Ext8;
        at[1] = 12;
        at[2] = static_cast<uint8_t>(timestampType);
        storeBigEndian(at + 3, nanoseconds);
        storeBigEndian(at + 7, static_cast<uint64_t>(seconds));
    }
}

void Encoder::writeExtension(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSValue typeValue;
    JSValue dataValue;
    if (object->structure() == m_extensionStructure) [[likely]] {
        typeValue = object->getDirect(extensionTypeOffset);
        dataValue = object->getDirect(extensionDataOffset);
    } else {
        typeValue = object->get(m_globalObject, vm.propertyNames->type);
        RETURN_IF_EXCEPTION(scope, void());
        dataValue = object->get(m_globalObject, builtinNames(vm).dataPublicName());
        RETURN_IF_EXCEPTION(scope, void());
    }

    int8_t type;
    if (!extensionTypeOf(m_globalObject, scope, typeValue, type))
        return;
    std::span<const uint8_t> data;
    if (!bytesOf(dataValue, data)) {
        throwTypeError(m_globalObject, scope, "Extension data must be an ArrayBufferView or an ArrayBuffer"_s);
        return;
    }

    size_t length = data.size();
    if (length > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        m_buffer.fail();
        return;
    }
    switch (length) {
    case 1:
        m_buffer.append(static_cast<uint8_t>(FixExt1));
        break;
    case 2:
        m_buffer.append(static_cast<uint8_t>(FixExt2));
        break;
    case 4:
        m_buffer.append(static_cast<uint8_t>(FixExt4));
        break;
    case 8:
        m_buffer.append(static_cast<uint8_t>(FixExt8));
        break;
    case 16:
        m_buffer.append(static_cast<uint8_t>(FixExt16));
        break;
    default:
        if (length <= 0xff)
            writeWithFormat(Ext8, static_cast<uint8_t>(length));
        else if (length <= 0xffff)
            writeWithFormat(Ext16, static_cast<uint16_t>(length));
        else
            writeWithFormat(Ext32, static_cast<uint32_t>(length));
    }
    if (uint8_t* at = m_buffer.extend(1 + length)) {
        at[0] = static_cast<uint8_t>(type);
        if (length)
            memcpy(at + 1, data.data(), length);
    }
}

inline void Encoder::writeElement(JSValue element, const Key& key)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    // A symbol, like undefined, is nil.
    if (!element.isObject())
        RELEASE_AND_RETURN(scope, write(element));

    JSValue value = toJSON(element, key);
    RETURN_IF_EXCEPTION(scope, void());
    if (isOmitted(value)) {
        m_buffer.append(static_cast<uint8_t>(Nil));
        return;
    }
    RELEASE_AND_RETURN(scope, write(value));
}

// False if the property is left out, or with an exception.
inline bool Encoder::writeProperty(UniquedStringImpl* name, JSValue property)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSValue value = property;
    if (property.isObject()) {
        value = toJSON(property, Key::named(name));
        RETURN_IF_EXCEPTION(scope, false);
    }
    if (isOmitted(value))
        return false;

    writeString(StringView(*name));
    write(value);
    RETURN_IF_EXCEPTION(scope, false);
    return true;
}

// Writes the elements up to the first hole of an array stored as int32 or as double. Returns how many.
uint32_t Encoder::writeNumbers(JSObject* array, uint32_t length)
{
    IndexingType indexingType = array->indexingType();
    uint32_t index = 0;
    if (hasInt32(indexingType)) {
        auto elements = array->butterfly()->contiguousInt32();
        for (; index < length; ++index) {
            JSValue element = elements.at(array, index).get();
            if (!element)
                break;
            writeInteger(element.asInt32());
        }
    } else if (hasDouble(indexingType)) {
        auto elements = array->butterfly()->contiguousDouble();
        for (; index < length; ++index) {
            double element = elements.at(array, index);
            if (element != element)
                break;
            writeDouble(element);
        }
    }
    return index;
}

void Encoder::writeArray(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    bool entered = enter(object);
    RETURN_IF_EXCEPTION(scope, void());
    ASSERT_UNUSED(entered, entered);

    bool isJSArray = JSC::isJSArray(object);
    uint64_t length = isJSArray ? uncheckedDowncast<JSArray>(object)->length() : toLength(m_globalObject, object);
    RETURN_IF_EXCEPTION(scope, void());
    if (length > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return;
    }

    writeArrayHeader(static_cast<uint32_t>(length));
    uint32_t index = 0;
    if (isJSArray) {
        index = writeNumbers(object, static_cast<uint32_t>(length));
        if (!checkBuffer(scope)) [[unlikely]]
            return;
    }
    for (; index < length; ++index) {
        JSValue element;
        if (isJSArray && object->canGetIndexQuickly(index))
            element = object->getIndexQuickly(index);
        else {
            element = object->get(m_globalObject, index);
            RETURN_IF_EXCEPTION(scope, void());
        }
        writeElement(element, Key::at(index));
        RETURN_IF_EXCEPTION(scope, void());
        if (!checkBuffer(scope)) [[unlikely]]
            return;
    }
    leave();
}

void Encoder::writeMap(JSMap* map)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    bool entered = enter(map);
    RETURN_IF_EXCEPTION(scope, void());
    ASSERT_UNUSED(entered, entered);

    // The entries as they are now: writing one can run code that changes the map.
    MarkedArgumentBuffer entries;
    auto* iterator = JSMapIterator::create(vm, m_globalObject->mapIteratorStructure(), map, IterationKind::Entries);
    JSValue key;
    JSValue value;
    while (iterator->nextKeyValue(m_globalObject, key, value)) {
        entries.append(key);
        entries.append(value);
    }
    if (entries.hasOverflowed() || entries.size() / 2 > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return;
    }

    writeMapHeader(static_cast<uint32_t>(entries.size() / 2));
    for (size_t i = 0; i < entries.size(); ++i) {
        writeElement(entries.at(i), Key::none());
        RETURN_IF_EXCEPTION(scope, void());
        if (!checkBuffer(scope)) [[unlikely]]
            return;
    }
    leave();
}

void Encoder::writeSet(JSSet* set)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    bool entered = enter(set);
    RETURN_IF_EXCEPTION(scope, void());
    ASSERT_UNUSED(entered, entered);

    MarkedArgumentBuffer members;
    auto* iterator = JSSetIterator::create(vm, m_globalObject->setIteratorStructure(), set, IterationKind::Keys);
    JSValue member;
    while (iterator->next(m_globalObject, member))
        members.append(member);
    if (members.hasOverflowed() || members.size() > std::numeric_limits<uint32_t>::max()) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return;
    }

    writeArrayHeader(static_cast<uint32_t>(members.size()));
    for (size_t i = 0; i < members.size(); ++i) {
        writeElement(members.at(i), Key::none());
        RETURN_IF_EXCEPTION(scope, void());
        if (!checkBuffer(scope)) [[unlikely]]
            return;
    }
    leave();
}

void Encoder::writeObject(JSObject* object)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    bool entered = enter(object);
    RETURN_IF_EXCEPTION(scope, void());
    ASSERT_UNUSED(entered, entered);

    // Properties can be left out, so the header is written for all of them and corrected at the end.
    size_t headerOffset = m_buffer.size();
    uint32_t headerCount = 0;
    uint32_t count = 0;

    Structure* structure = object->structure();
    // The names and the offsets of a structure that is not a dictionary stay what they are.
    if (!structure->isDictionary() && canPerformFastPropertyNameEnumerationForJSONStringifyWithSideEffect(structure) && structure->canPerformFastPropertyEnumeration()) {
        Vector<std::pair<UniquedStringImpl*, PropertyOffset>, 16> properties;
        structure->forEachProperty(vm, [&](const PropertyTableEntry& entry) -> bool {
            if (entry.attributes() & PropertyAttribute::DontEnum)
                return true;
            if (entry.key()->isSymbol())
                return true;
            properties.append({ entry.key(), entry.offset() });
            return true;
        });
        // The structure keeps the names alive, whatever happens to the object while its values are written.
        EnsureStillAliveScope keepStructure { JSValue(structure) };

        headerCount = properties.size();
        writeMapHeader(headerCount);
        for (auto& [name, offset] : properties) {
            JSValue property;
            if (object->structure() == structure) [[likely]]
                property = object->getDirect(offset);
            else {
                property = object->get(m_globalObject, PropertyName(name));
                RETURN_IF_EXCEPTION(scope, void());
            }
            bool written = writeProperty(name, property);
            RETURN_IF_EXCEPTION(scope, void());
            count += written;
            if (!checkBuffer(scope)) [[unlikely]]
                return;
        }
    } else {
        PropertyNameArrayBuilder names(vm, PropertyNameMode::Strings, PrivateSymbolMode::Exclude);
        object->methodTable()->getOwnPropertyNames(object, m_globalObject, names, DontEnumPropertiesMode::Exclude);
        RETURN_IF_EXCEPTION(scope, void());

        headerCount = names.size();
        writeMapHeader(headerCount);
        for (auto& name : names) {
            JSValue property = object->get(m_globalObject, name);
            RETURN_IF_EXCEPTION(scope, void());
            bool written = writeProperty(name.impl(), property);
            RETURN_IF_EXCEPTION(scope, void());
            count += written;
            if (!checkBuffer(scope)) [[unlikely]]
                return;
        }
    }

    if (count != headerCount) {
        if (!checkBuffer(scope)) [[unlikely]]
            return;
        // Properties were left out. The header for fewer of them is the same size or smaller.
        size_t written = mapHeaderSize(headerCount);
        size_t needed = mapHeaderSize(count);
        size_t end = m_buffer.size();
        uint8_t* header = m_buffer.data() + headerOffset;
        if (needed != written)
            memmove(header + needed, header + written, end - headerOffset - written);
        if (count < 16)
            header[0] = static_cast<uint8_t>(FixMap | count);
        else if (count <= 0xffff) {
            header[0] = Map16;
            storeBigEndian(header + 1, static_cast<uint16_t>(count));
        } else {
            header[0] = Map32;
            storeBigEndian(header + 1, count);
        }
        m_buffer.shrink(end - (written - needed));
    }
    leave();
}

// ───────────────────────────── decode ─────────────────────────────

class Decoder {
    WTF_MAKE_NONCOPYABLE(Decoder);
    WTF_FORBID_HEAP_ALLOCATION;

public:
    Decoder(JSGlobalObject* globalObject, std::span<const uint8_t> input)
        : m_globalObject(globalObject)
        , m_vm(globalObject->vm())
        , m_position(input.data())
        , m_end(input.data() + input.size())
        , m_usesStrings(input.size() >= minInputLengthForStrings)
    {
    }

    // Empty on failure: an exception was thrown, or error() says what is wrong with the input.
    JSValue read();

    // Null if nothing is wrong with the input.
    ASCIILiteral error() const { return m_error; }
    // The input ended inside a value: more of it may make it one.
    bool isIncomplete() const { return m_isIncomplete; }
    const uint8_t* position() const { return m_position; }
    bool isAtEnd() const { return m_position == m_end; }

    // Null with an exception.
    static JSArray* makeArray(JSGlobalObject*, std::span<const JSValue>);

    static constexpr ASCIILiteral unexpectedEnd = "Unexpected end of MessagePack data"_s;
    static constexpr ASCIILiteral neverUsed = "0xc1 is not a MessagePack type"_s;

    // What is wrong with a map key that starts with `byte` and is not a string or a number.
    static ASCIILiteral invalidKey(uint8_t byte)
    {
        if (byte >= FixMap && byte < FixArray)
            return "A MessagePack map key must be a string or a number, not a map"_s;
        if (byte >= FixArray && byte < FixStr)
            return "A MessagePack map key must be a string or a number, not an array"_s;
        switch (byte) {
        case Nil:
            return "A MessagePack map key must be a string or a number, not nil"_s;
        case NeverUsed:
            return neverUsed;
        case False:
        case True:
            return "A MessagePack map key must be a string or a number, not a boolean"_s;
        case Bin8:
        case Bin16:
        case Bin32:
            return "A MessagePack map key must be a string or a number, not binary"_s;
        case Array16:
        case Array32:
            return "A MessagePack map key must be a string or a number, not an array"_s;
        case Map16:
        case Map32:
            return "A MessagePack map key must be a string or a number, not a map"_s;
        default:
            return "A MessagePack map key must be a string or a number, not an extension"_s;
        }
    }

private:
    size_t remaining() const { return m_end - m_position; }

    JSValue fail(ASCIILiteral message)
    {
        m_error = message;
        return {};
    }

    JSValue incomplete()
    {
        m_isIncomplete = true;
        return fail(unexpectedEnd);
    }

    template<typename T>
    ALWAYS_INLINE bool take(T& value)
    {
        if (remaining() < sizeof(T)) [[unlikely]] {
            incomplete();
            return false;
        }
        value = loadBigEndian<T>(m_position);
        m_position += sizeof(T);
        return true;
    }

    ALWAYS_INLINE bool take(size_t length, std::span<const uint8_t>& bytes)
    {
        if (remaining() < length) [[unlikely]] {
            incomplete();
            return false;
        }
        bytes = { m_position, length };
        m_position += length;
        return true;
    }

    // A length of 1, 2 or 4 bytes.
    template<typename LengthType>
    ALWAYS_INLINE bool takeLength(size_t& length)
    {
        LengthType value;
        if (!take(value))
            return false;
        length = value;
        return true;
    }

    template<typename T>
    ALWAYS_INLINE JSValue readNumber()
    {
        T value;
        if (!take(value))
            return {};
        return jsNumber(value);
    }

    JSValue readString(size_t length);
    JSValue readBinary(size_t length);
    JSValue readExtension(size_t length);
    JSValue readTimestamp(std::span<const uint8_t>);
    bool readPrimitive(JSValue&);
    JSValue readArray(size_t length);
    JSValue readMap(size_t length);
    JSValue readInt64(int64_t);
    JSValue readUint64(uint64_t);
    bool readKey(Structure*, Structure*& transition, PropertyOffset&, Identifier&);

    JSUint8Array* copy(std::span<const uint8_t>);

    JSGlobalObject* m_globalObject;
    VM& m_vm;
    // The elements of the arrays that are being read, the innermost last.
    MarkedArgumentBuffer m_elements;
    // Short strings this decoder made, two for each hash, to be found again by their bytes. The stack keeps them alive.
    static constexpr size_t maxCachedStringLength = 32;
    static constexpr size_t minInputLengthForStrings = 512;
    static constexpr unsigned stringSetsLog2 = 6;
    JSString* m_strings[1 << stringSetsLog2][2];
    bool m_usesStrings;
    bool m_hasStrings { false };
    const uint8_t* m_position;
    const uint8_t* m_end;
    ASCIILiteral m_error;
    bool m_isIncomplete { false };
};

JSValue Decoder::read()
{
    if (m_position == m_end) [[unlikely]]
        return incomplete();

    uint8_t byte = *m_position++;
    if (byte < FixMap)
        return jsNumber(byte);
    if (byte < FixArray)
        return readMap(byte & 0x0f);
    if (byte < FixStr)
        return readArray(byte & 0x0f);
    if (byte < Nil)
        return readString(byte & 0x1f);
    if (byte > Map32)
        return jsNumber(static_cast<int8_t>(byte));

    size_t length;
    switch (byte) {
    case Nil:
        return jsNull();
    case False:
        return jsBoolean(false);
    case True:
        return jsBoolean(true);
    case Bin8:
        return takeLength<uint8_t>(length) ? readBinary(length) : JSValue();
    case Bin16:
        return takeLength<uint16_t>(length) ? readBinary(length) : JSValue();
    case Bin32:
        return takeLength<uint32_t>(length) ? readBinary(length) : JSValue();
    case Ext8:
        return takeLength<uint8_t>(length) ? readExtension(length) : JSValue();
    case Ext16:
        return takeLength<uint16_t>(length) ? readExtension(length) : JSValue();
    case Ext32:
        return takeLength<uint32_t>(length) ? readExtension(length) : JSValue();
    case Float32: {
        uint32_t bits;
        if (!take(bits))
            return {};
        // Any bits can be in the input. Those of a NaN are not all the bits of a JSValue that is a number.
        return jsNumber(purifyNaN(static_cast<double>(std::bit_cast<float>(bits))));
    }
    case Float64: {
        uint64_t bits;
        if (!take(bits))
            return {};
        return jsNumber(purifyNaN(std::bit_cast<double>(bits)));
    }
    case Uint8:
        return readNumber<uint8_t>();
    case Uint16:
        return readNumber<uint16_t>();
    case Uint32:
        return readNumber<uint32_t>();
    case Uint64: {
        uint64_t value;
        if (!take(value))
            return {};
        return readUint64(value);
    }
    case Int8:
        return readNumber<int8_t>();
    case Int16:
        return readNumber<int16_t>();
    case Int32:
        return readNumber<int32_t>();
    case Int64: {
        uint64_t value;
        if (!take(value))
            return {};
        return readInt64(static_cast<int64_t>(value));
    }
    case FixExt1:
        return readExtension(1);
    case FixExt2:
        return readExtension(2);
    case FixExt4:
        return readExtension(4);
    case FixExt8:
        return readExtension(8);
    case FixExt16:
        return readExtension(16);
    case Str8:
        return takeLength<uint8_t>(length) ? readString(length) : JSValue();
    case Str16:
        return takeLength<uint16_t>(length) ? readString(length) : JSValue();
    case Str32:
        return takeLength<uint32_t>(length) ? readString(length) : JSValue();
    case Array16:
        return takeLength<uint16_t>(length) ? readArray(length) : JSValue();
    case Array32:
        return takeLength<uint32_t>(length) ? readArray(length) : JSValue();
    case Map16:
        return takeLength<uint16_t>(length) ? readMap(length) : JSValue();
    case Map32:
        return takeLength<uint32_t>(length) ? readMap(length) : JSValue();
    default:
        ASSERT(byte == NeverUsed);
        return fail(neverUsed);
    }
}

// A number while a double holds it exactly, a BigInt beyond.
JSValue Decoder::readUint64(uint64_t value)
{
    if (value <= static_cast<uint64_t>(maxSafeInteger))
        return jsNumber(static_cast<double>(value));
    return JSBigInt::createFrom(m_globalObject, value);
}

JSValue Decoder::readInt64(int64_t value)
{
    if (value >= -maxSafeInteger && value <= maxSafeInteger)
        return jsNumber(static_cast<double>(value));
    return JSBigInt::createFrom(m_globalObject, value);
}

JSValue Decoder::readString(size_t length)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    std::span<const uint8_t> bytes;
    if (!take(length, bytes))
        return {};

    if (!isAllASCII(bytes)) [[unlikely]] {
        // Bytes that are not UTF-8 become U+FFFD, as for TextDecoder.
        String string = String::fromUTF8ReplacingInvalidSequences(byteCast<char8_t>(bytes));
        if (string.isNull()) [[unlikely]] {
            throwOutOfMemoryError(m_globalObject, scope);
            return {};
        }
        return jsString(vm, WTF::move(string));
    }

    if (!length)
        return jsEmptyString(vm);
    if (length == 1)
        return jsSingleCharacterString(vm, bytes[0]);

    // A value that repeats, as the values of an enumeration do, is one string. Nothing is made an atom for it.
    JSString** cached = nullptr;
    if (m_usesStrings && length <= maxCachedStringLength) {
        if (!m_hasStrings) {
            memset(m_strings, 0, sizeof(m_strings));
            m_hasStrings = true;
        }
        uint64_t head = 0;
        uint64_t tail = 0;
        memcpy(&head, bytes.data(), std::min<size_t>(length, sizeof(head)));
        memcpy(&tail, bytes.data() + length - std::min<size_t>(length, sizeof(tail)), std::min<size_t>(length, sizeof(tail)));
        uint64_t hash = (head * 0x9E3779B97F4A7C15ULL) ^ (tail * 0xC2B2AE3D27D4EB4FULL) ^ length;
        cached = m_strings[(hash * 0x9E3779B97F4A7C15ULL) >> (64 - stringSetsLog2)];
        for (unsigned way = 0; way < 2; ++way) {
            JSString* string = cached[way];
            if (!string)
                continue;
            StringImpl* impl = string->getValueImpl();
            if (impl->length() == length && !memcmp(impl->span8().data(), bytes.data(), length))
                return string;
        }
    }

    std::span<Latin1Character> characters;
    auto impl = StringImpl::tryCreateUninitialized(length, characters);
    if (!impl) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return {};
    }
    memcpy(characters.data(), bytes.data(), length);
    JSString* string = jsNontrivialString(vm, String(WTF::move(impl)));
    if (cached) {
        cached[1] = cached[0];
        cached[0] = string;
    }
    return string;
}

JSUint8Array* Decoder::copy(std::span<const uint8_t> bytes)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);
    auto* array = JSUint8Array::createUninitialized(m_globalObject, m_globalObject->m_typedArrayUint8.get(m_globalObject), bytes.size());
    RETURN_IF_EXCEPTION(scope, nullptr);
    if (!bytes.empty())
        memcpy(array->typedVector(), bytes.data(), bytes.size());
    return array;
}

JSValue Decoder::readBinary(size_t length)
{
    std::span<const uint8_t> bytes;
    if (!take(length, bytes))
        return {};
    return copy(bytes);
}

JSValue Decoder::readExtension(size_t length)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    uint8_t typeByte;
    if (!take(typeByte))
        return {};
    std::span<const uint8_t> data;
    if (!take(length, data))
        return {};

    int8_t type = static_cast<int8_t>(typeByte);
    if (type == timestampType)
        return readTimestamp(data);

    JSUint8Array* dataArray = copy(data);
    RETURN_IF_EXCEPTION(scope, {});
    auto* zigGlobalObject = defaultGlobalObject(m_globalObject);
    JSObject* extension = JSFinalObject::create(vm, zigGlobalObject->m_JSMessagePackExtensionClassStructure.get(zigGlobalObject));
    extension->putDirectOffset(vm, extensionTypeOffset, jsNumber(type));
    extension->putDirectOffset(vm, extensionDataOffset, dataArray);
    return extension;
}

JSValue Decoder::readTimestamp(std::span<const uint8_t> data)
{
    int64_t seconds;
    uint32_t nanoseconds;
    switch (data.size()) {
    case 4:
        seconds = loadBigEndian<uint32_t>(data.data());
        nanoseconds = 0;
        break;
    case 8: {
        uint64_t both = loadBigEndian<uint64_t>(data.data());
        nanoseconds = both >> 34;
        seconds = both & ((1ull << 34) - 1);
        break;
    }
    case 12:
        nanoseconds = loadBigEndian<uint32_t>(data.data());
        seconds = static_cast<int64_t>(loadBigEndian<uint64_t>(data.data() + 4));
        break;
    default:
        return fail("A MessagePack timestamp has 4, 8 or 12 bytes"_s);
    }
    if (nanoseconds >= nanosecondsPerSecond)
        return fail("A MessagePack timestamp has less than a second of nanoseconds"_s);
    if (seconds < -maxDateSeconds || seconds > maxDateSeconds)
        return fail("MessagePack timestamp is outside of what a Date can hold"_s);

    // A Date has milliseconds. The rest of the nanoseconds is dropped.
    int64_t milliseconds = seconds * 1000 + nanoseconds / 1000000;
    if (milliseconds > maxDateSeconds * 1000)
        return fail("MessagePack timestamp is outside of what a Date can hold"_s);
    return DateInstance::create(m_vm, m_globalObject->dateStructure(), static_cast<double>(milliseconds));
}

// As JSON.parse makes an array: once, with the length and the storage its elements need.
JSArray* Decoder::makeArray(JSGlobalObject* globalObject, std::span<const JSValue> values)
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    if (values.empty())
        RELEASE_AND_RETURN(scope, constructEmptyArray(globalObject, nullptr));

    IndexingType indexingType = ArrayWithInt32;
    for (JSValue value : values) {
        if (value.isInt32())
            continue;
        // NaN is how a double array says that an element is missing.
        if (value.isDouble() && !std::isnan(value.asDouble())) {
            indexingType = ArrayWithDouble;
            continue;
        }
        indexingType = ArrayWithContiguous;
        break;
    }

    if (values.size() <= std::numeric_limits<unsigned>::max()) {
        ObjectInitializationScope initializationScope(vm);
        Structure* structure = globalObject->arrayStructureForIndexingTypeDuringAllocation(indexingType);
        if (JSArray* array = JSArray::tryCreateUninitializedRestricted(initializationScope, structure, static_cast<unsigned>(values.size()))) [[likely]] {
            for (unsigned i = 0; i < values.size(); ++i)
                array->initializeIndex(initializationScope, i, values[i]);
            return array;
        }
    }

    // An array that cannot be allocated at once grows until it throws.
    JSArray* array = constructEmptyArray(globalObject, nullptr);
    RETURN_IF_EXCEPTION(scope, nullptr);
    for (size_t i = 0; i < values.size(); ++i) {
        array->putDirectIndex(globalObject, i, values[i]);
        RETURN_IF_EXCEPTION(scope, nullptr);
    }
    return array;
}

// The next value if it is nil, a boolean or a number that is not a BigInt. False, with nothing read, for any other.
ALWAYS_INLINE bool Decoder::readPrimitive(JSValue& value)
{
    if (m_position == m_end) [[unlikely]]
        return false;
    uint8_t byte = *m_position;
    if (byte < FixMap) {
        value = jsNumber(byte);
        ++m_position;
        return true;
    }
    if (byte > Map32) {
        value = jsNumber(static_cast<int8_t>(byte));
        ++m_position;
        return true;
    }

    const uint8_t* payload = m_position + 1;
    size_t available = m_end - payload;
    size_t size = 0;
    switch (byte) {
    case Nil:
        value = jsNull();
        break;
    case False:
        value = jsBoolean(false);
        break;
    case True:
        value = jsBoolean(true);
        break;
    case Uint8:
    case Int8:
        if (available < 1)
            return false;
        value = byte == Uint8 ? jsNumber(*payload) : jsNumber(static_cast<int8_t>(*payload));
        size = 1;
        break;
    case Uint16:
    case Int16:
        if (available < 2)
            return false;
        value = byte == Uint16 ? jsNumber(loadBigEndian<uint16_t>(payload)) : jsNumber(loadBigEndian<int16_t>(payload));
        size = 2;
        break;
    case Uint32:
    case Int32:
        if (available < 4)
            return false;
        value = byte == Uint32 ? jsNumber(loadBigEndian<uint32_t>(payload)) : jsNumber(loadBigEndian<int32_t>(payload));
        size = 4;
        break;
    case Float32:
        if (available < 4)
            return false;
        value = jsNumber(purifyNaN(static_cast<double>(std::bit_cast<float>(loadBigEndian<uint32_t>(payload)))));
        size = 4;
        break;
    case Float64:
        if (available < 8)
            return false;
        value = jsNumber(purifyNaN(std::bit_cast<double>(loadBigEndian<uint64_t>(payload))));
        size = 8;
        break;
    case Uint64: {
        if (available < 8)
            return false;
        uint64_t number = loadBigEndian<uint64_t>(payload);
        if (number > static_cast<uint64_t>(maxSafeInteger))
            return false;
        value = jsNumber(static_cast<double>(number));
        size = 8;
        break;
    }
    case Int64: {
        if (available < 8)
            return false;
        int64_t number = loadBigEndian<int64_t>(payload);
        if (number < -maxSafeInteger || number > maxSafeInteger)
            return false;
        value = jsNumber(static_cast<double>(number));
        size = 8;
        break;
    }
    default:
        return false;
    }
    m_position = payload + size;
    return true;
}

JSValue Decoder::readArray(size_t length)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    // Every element is a byte or more, so no more than the input has are read.
    if (length > remaining()) [[unlikely]]
        return incomplete();
    if (!length)
        RELEASE_AND_RETURN(scope, constructEmptyArray(m_globalObject, nullptr));

    if (!vm.isSafeToRecurseSoft()) [[unlikely]] {
        throwStackOverflowError(m_globalObject, scope);
        return {};
    }

    // None of these is a cell, so the collector has nothing to find here.
    Vector<JSValue, 32> primitives;
    while (primitives.size() < length) {
        JSValue primitive;
        if (!readPrimitive(primitive))
            break;
        // Twice the room each time it runs out, and never more than the array can have.
        if (primitives.size() == primitives.capacity() && !primitives.tryReserveCapacity(std::min(length, primitives.capacity() * 2))) [[unlikely]] {
            throwOutOfMemoryError(m_globalObject, scope);
            return {};
        }
        primitives.append(primitive);
    }
    if (primitives.size() == length)
        RELEASE_AND_RETURN(scope, makeArray(m_globalObject, primitives.span()));

    size_t base = m_elements.size();
    for (JSValue primitive : primitives)
        m_elements.append(primitive);
    for (size_t i = primitives.size(); i < length; ++i) {
        JSValue element = read();
        RETURN_IF_EXCEPTION(scope, {});
        if (!element) [[unlikely]]
            return {};
        m_elements.append(element);
    }
    if (m_elements.hasOverflowed()) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return {};
    }

    JSArray* array = makeArray(m_globalObject, m_elements.span().subspan(base));
    RETURN_IF_EXCEPTION(scope, {});
    m_elements.shrink(base);
    return array;
}

// False if the key is not a string or a number, the input ended, or an exception was thrown.
bool Decoder::readKey(Structure* structure, Structure*& transition, PropertyOffset& offset, Identifier& key)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    if (m_position == m_end) [[unlikely]] {
        incomplete();
        return false;
    }

    uint8_t byte = *m_position;
    size_t length;
    if (byte >= FixStr && byte < Nil) [[likely]] {
        ++m_position;
        length = byte & 0x1f;
    } else if (byte == Str8 || byte == Str16 || byte == Str32) {
        ++m_position;
        bool hasLength = byte == Str8 ? takeLength<uint8_t>(length) : byte == Str16 ? takeLength<uint16_t>(length)
                                                                                    : takeLength<uint32_t>(length);
        if (!hasLength)
            return false;
    } else if (byte < FixMap || byte > Map32 || (byte >= Float32 && byte <= Int64)) {
        JSValue number = read();
        RETURN_IF_EXCEPTION(scope, false);
        if (!number)
            return false;
        if (number.isInt32())
            key = Identifier::from(vm, number.asInt32());
        else if (number.isDouble())
            key = Identifier::from(vm, number.asDouble());
        else {
            // A 64-bit integer that became a BigInt.
            String digits = number.toWTFString(m_globalObject);
            RETURN_IF_EXCEPTION(scope, false);
            key = Identifier::fromString(vm, digits);
        }
        return true;
    } else {
        fail(invalidKey(byte));
        return false;
    }

    std::span<const uint8_t> bytes;
    if (!take(length, bytes))
        return false;
    if (isAllASCII(bytes)) [[likely]] {
        // As JSON.parse does: the next property of a shape that was made before comes from the structure's transition.
        if (Structure* single = structure->trySingleTransition()) {
            if (single->transitionKind() == TransitionKind::PropertyAddition && !single->transitionPropertyAttributes()) {
                UniquedStringImpl* name = single->transitionPropertyName();
                bool isSameName = name->is8Bit() ? name->length() == bytes.size() && !memcmp(name->span8().data(), bytes.data(), bytes.size()) : WTF::equal(name, bytes);
                if (isSameName) {
                    transition = single;
                    offset = single->transitionOffset();
                    return true;
                }
            }
        } else if (!structure->isDictionary()) {
            if (AtomStringImpl* atom = vm.jsonCache().existingIdentifier(vm, bytes)) {
                transition = Structure::addPropertyTransitionToExistingStructure(structure, atom, 0, offset);
                if (!transition)
                    key = Identifier::fromString(vm, atom);
                return true;
            }
        }
        key = Identifier::fromString(vm, vm.jsonCache().makeIdentifier(vm, bytes));
        return true;
    }

    String string = String::fromUTF8ReplacingInvalidSequences(byteCast<char8_t>(bytes));
    if (string.isNull()) [[unlikely]] {
        throwOutOfMemoryError(m_globalObject, scope);
        return false;
    }
    key = Identifier::fromString(vm, string);
    return true;
}

JSValue Decoder::readMap(size_t length)
{
    VM& vm = m_vm;
    auto scope = DECLARE_THROW_SCOPE(vm);

    // A key and a value are two bytes or more.
    if (length > remaining() / 2) [[unlikely]]
        return incomplete();

    if (!vm.isSafeToRecurseSoft()) [[unlikely]] {
        throwStackOverflowError(m_globalObject, scope);
        return {};
    }

    // Up to the properties an empty object has room for, it is the empty object that JSON.parse starts from.
    JSObject* object = length <= JSFinalObject::defaultInlineCapacity
        ? constructEmptyObject(m_globalObject)
        : constructEmptyObject(m_globalObject, m_globalObject->objectPrototype(), std::min<size_t>(length, JSFinalObject::maxInlineCapacity));
    for (size_t i = 0; i < length; ++i) {
        Structure* structure = object->structure();
        Structure* transition = nullptr;
        PropertyOffset offset = invalidOffset;
        Identifier key;
        bool hasKey = readKey(structure, transition, offset, key);
        RETURN_IF_EXCEPTION(scope, {});
        if (!hasKey) [[unlikely]]
            return {};
        JSValue value = read();
        RETURN_IF_EXCEPTION(scope, {});
        if (!value) [[unlikely]]
            return {};

        if (transition) [[likely]] {
            if (offset >= firstOutOfLineOffset && structure->outOfLineCapacity() != transition->outOfLineCapacity()) [[unlikely]] {
                Butterfly* butterfly = object->allocateMoreOutOfLineStorage(vm, structure->outOfLineCapacity(), transition->outOfLineCapacity());
                object->nukeStructureAndSetButterfly(vm, structure->id(), butterfly);
            }
            object->putDirectOffset(vm, offset, value);
            object->setStructure(vm, transition);
            continue;
        }
        // As for JSON.parse, "__proto__" is an ordinary property and a repeated key takes the last value.
        object->putDirectMayBeIndex(m_globalObject, key, value);
        RETURN_IF_EXCEPTION(scope, {});
    }
    return object;
}

// ───────────────────────────── Bun.msgpack ─────────────────────────────

JSC_DEFINE_HOST_FUNCTION(jsFunctionMessagePackEncode, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    Encoder encoder(globalObject);
    encoder.writeRoot(callFrame->argument(0));
    RETURN_IF_EXCEPTION(scope, {});
    RELEASE_AND_RETURN(scope, JSValue::encode(encoder.takeBytes()));
}

// False with an exception.
static bool inputOf(JSGlobalObject* globalObject, ThrowScope& scope, JSValue value, ASCIILiteral functionName, std::span<const uint8_t>& bytes)
{
    if (!bytesOf(value, bytes)) {
        throwTypeError(globalObject, scope, makeString("Bun.msgpack."_s, functionName, " expects an ArrayBufferView or an ArrayBuffer"_s));
        return false;
    }
    if (isDetached(value)) {
        throwTypeError(globalObject, scope, "ArrayBuffer is detached"_s);
        return false;
    }
    return true;
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionMessagePackDecode, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    std::span<const uint8_t> input;
    if (!inputOf(globalObject, scope, callFrame->argument(0), "decode"_s, input))
        return {};

    Decoder decoder(globalObject, input);
    JSValue value = decoder.read();
    RETURN_IF_EXCEPTION(scope, {});
    if (!value) {
        throwSyntaxError(globalObject, scope, decoder.error());
        return {};
    }
    if (!decoder.isAtEnd()) {
        throwSyntaxError(globalObject, scope, "Unexpected data after the MessagePack value"_s);
        return {};
    }
    return JSValue::encode(value);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionMessagePackDecodeChunk, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    std::span<const uint8_t> input;
    if (!inputOf(globalObject, scope, callFrame->argument(0), "decodeChunk"_s, input))
        return {};

    // Clamped to the input, and start to end, as Bun.JSONL.parseChunk does.
    size_t start = 0;
    size_t end = input.size();
    JSValue startArgument = callFrame->argument(1);
    if (startArgument.isNumber()) {
        double number = startArgument.asNumber();
        if (number > 0)
            start = static_cast<size_t>(std::min(number, static_cast<double>(input.size())));
    }
    JSValue endArgument = callFrame->argument(2);
    if (endArgument.isNumber()) {
        double number = endArgument.asNumber();
        if (number >= 0)
            end = static_cast<size_t>(std::min(number, static_cast<double>(input.size())));
    }
    if (start > end)
        start = end;

    MarkedArgumentBuffer values;
    ASCIILiteral error;
    size_t read = start;
    Decoder decoder(globalObject, input.subspan(start, end - start));
    while (read < end) {
        JSValue value = decoder.read();
        RETURN_IF_EXCEPTION(scope, {});
        if (!value) {
            // The rest of a value that has only arrived in part is not an error: it may still come.
            if (!decoder.isIncomplete())
                error = decoder.error();
            break;
        }
        values.append(value);
        read = decoder.position() - input.data();
    }
    if (values.hasOverflowed()) [[unlikely]] {
        throwOutOfMemoryError(globalObject, scope);
        return {};
    }

    JSArray* array = Decoder::makeArray(globalObject, values.span());
    RETURN_IF_EXCEPTION(scope, {});
    JSValue errorValue = error.isNull() ? jsNull() : JSValue(createSyntaxError(globalObject, error));

    // { values, read, done, error }, the result of Bun.JSONL.parseChunk.
    auto* zigGlobalObject = defaultGlobalObject(globalObject);
    JSObject* result = constructEmptyObject(vm, zigGlobalObject->jsonlParseResultStructure());
    result->putDirectOffset(vm, 0, array);
    result->putDirectOffset(vm, 1, jsNumber(read));
    result->putDirectOffset(vm, 2, jsBoolean(read == end));
    result->putDirectOffset(vm, 3, errorValue);
    return JSValue::encode(result);
}

// ───────────────────────────── Bun.msgpack.Extension ─────────────────────────────

JSC_DECLARE_HOST_FUNCTION(callExtension);
JSC_DECLARE_HOST_FUNCTION(constructExtension);

class JSExtensionPrototype final : public JSC::JSNonFinalObject {
public:
    using Base = JSC::JSNonFinalObject;
    static constexpr unsigned StructureFlags = Base::StructureFlags;

    static JSExtensionPrototype* create(JSC::VM& vm, JSC::JSGlobalObject*, JSC::Structure* structure)
    {
        JSExtensionPrototype* prototype = new (NotNull, JSC::allocateCell<JSExtensionPrototype>(vm)) JSExtensionPrototype(vm, structure);
        prototype->finishCreation(vm);
        return prototype;
    }

    DECLARE_INFO;

    template<typename CellType, JSC::SubspaceAccess>
    static JSC::GCClient::IsoSubspace* subspaceFor(JSC::VM& vm)
    {
        return &vm.plainObjectSpace();
    }

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        auto* structure = Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::ObjectType, StructureFlags), info());
        structure->setMayBePrototype(true);
        return structure;
    }

private:
    JSExtensionPrototype(JSC::VM& vm, JSC::Structure* structure)
        : Base(vm, structure)
    {
    }

    void finishCreation(JSC::VM& vm)
    {
        Base::finishCreation(vm);
        Bun::putToStringTagWithoutTransition(vm, this, info());
    }
};

class JSExtensionConstructor final : public JSC::InternalFunction {
public:
    using Base = JSC::InternalFunction;
    static constexpr unsigned StructureFlags = Base::StructureFlags;

    static JSExtensionConstructor* create(JSC::VM& vm, JSC::Structure* structure, JSC::JSObject* prototype)
    {
        JSExtensionConstructor* constructor = new (NotNull, JSC::allocateCell<JSExtensionConstructor>(vm)) JSExtensionConstructor(vm, structure);
        constructor->finishCreation(vm, prototype);
        return constructor;
    }

    DECLARE_INFO;

    template<typename CellType, JSC::SubspaceAccess>
    static JSC::GCClient::IsoSubspace* subspaceFor(JSC::VM& vm)
    {
        return &vm.internalFunctionSpace();
    }

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        return Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::InternalFunctionType, StructureFlags), info());
    }

private:
    JSExtensionConstructor(JSC::VM& vm, JSC::Structure* structure)
        : Base(vm, structure, callExtension, constructExtension)
    {
    }

    void finishCreation(JSC::VM& vm, JSC::JSObject* prototype)
    {
        Base::finishCreation(vm, 2, "Extension"_s);
        putDirectWithoutTransition(vm, vm.propertyNames->prototype, prototype, JSC::PropertyAttribute::DontEnum | JSC::PropertyAttribute::DontDelete | JSC::PropertyAttribute::ReadOnly);
    }
};

const ClassInfo JSExtensionPrototype::s_info = { "Extension"_s, &Base::s_info, nullptr, nullptr, CREATE_METHOD_TABLE(JSExtensionPrototype) };
const ClassInfo JSExtensionConstructor::s_info = { "Extension"_s, &Base::s_info, nullptr, nullptr, CREATE_METHOD_TABLE(JSExtensionConstructor) };

JSC_DEFINE_HOST_FUNCTION(callExtension, (JSGlobalObject * globalObject, CallFrame*))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);
    throwTypeError(globalObject, scope, "Class constructor Extension cannot be invoked without 'new'"_s);
    return {};
}

JSC_DEFINE_HOST_FUNCTION(constructExtension, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    VM& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    int8_t type;
    if (!extensionTypeOf(globalObject, scope, callFrame->argument(0), type))
        return {};

    // The data is kept as it is given when it is a Uint8Array. Anything else becomes one, over the same memory.
    JSValue data = callFrame->argument(1);
    JSCell* dataCell = data.isCell() ? data.asCell() : nullptr;
    if (dataCell && isTypedArrayTypeIncludingDataView(dataCell->type())) {
        if (dataCell->type() != Uint8ArrayType) {
            auto* view = uncheckedDowncast<JSArrayBufferView>(dataCell);
            RefPtr<ArrayBuffer> buffer = view->possiblySharedBuffer();
            if (!buffer) {
                throwOutOfMemoryError(globalObject, scope);
                return {};
            }
            Structure* arrayStructure = globalObject->typedArrayStructure(TypeUint8, buffer->isResizableOrGrowableShared());
            data = JSUint8Array::create(globalObject, arrayStructure, WTF::move(buffer), view->byteOffset(), view->byteLength());
            RETURN_IF_EXCEPTION(scope, {});
        }
    } else if (dataCell && dataCell->type() == ArrayBufferType) {
        RefPtr<ArrayBuffer> buffer = uncheckedDowncast<JSArrayBuffer>(dataCell)->impl();
        size_t length = buffer->byteLength();
        Structure* arrayStructure = globalObject->typedArrayStructure(TypeUint8, buffer->isResizableOrGrowableShared());
        data = JSUint8Array::create(globalObject, arrayStructure, WTF::move(buffer), 0, length);
        RETURN_IF_EXCEPTION(scope, {});
    } else {
        throwTypeError(globalObject, scope, "Extension data must be an ArrayBufferView or an ArrayBuffer"_s);
        return {};
    }

    auto* zigGlobalObject = defaultGlobalObject(globalObject);
    Structure* structure = zigGlobalObject->m_JSMessagePackExtensionClassStructure.get(zigGlobalObject);
    JSValue newTarget = callFrame->newTarget();
    if (zigGlobalObject->m_JSMessagePackExtensionClassStructure.constructor(zigGlobalObject) != newTarget) [[unlikely]] {
        // A class that extends Extension.
        auto* functionGlobalObject = defaultGlobalObject(getFunctionRealm(globalObject, newTarget.getObject()));
        RETURN_IF_EXCEPTION(scope, {});
        Structure* subclassStructure = InternalFunction::createSubclassStructure(globalObject, newTarget.getObject(), functionGlobalObject->m_JSMessagePackExtensionClassStructure.get(functionGlobalObject));
        RETURN_IF_EXCEPTION(scope, {});
        if (subclassStructure != structure) {
            JSObject* extension = JSFinalObject::create(vm, subclassStructure);
            extension->putDirect(vm, vm.propertyNames->type, jsNumber(type), 0);
            extension->putDirect(vm, builtinNames(vm).dataPublicName(), data, 0);
            return JSValue::encode(extension);
        }
    }

    JSObject* extension = JSFinalObject::create(vm, structure);
    extension->putDirectOffset(vm, extensionTypeOffset, jsNumber(type));
    extension->putDirectOffset(vm, extensionDataOffset, data);
    return JSValue::encode(extension);
}

} // namespace MessagePack

void setupMessagePackExtensionClassStructure(LazyClassStructure::Initializer& init)
{
    using namespace MessagePack;

    VM& vm = init.vm;
    auto* prototype = JSExtensionPrototype::create(vm, init.global, JSExtensionPrototype::createStructure(vm, init.global, init.global->objectPrototype()));
    // An Extension is an object with two properties, `type` and `data`, at offsets the decoder writes to.
    Structure* structure = createClassStructure(vm, init.global, prototype, TypeInfo(FinalObjectType, 0), JSFinalObject::info(), NonArray, 2);
    PropertyOffset offset;
    structure = Structure::addPropertyTransition(vm, structure, vm.propertyNames->type, 0, offset);
    RELEASE_ASSERT(offset == extensionTypeOffset);
    structure = Structure::addPropertyTransition(vm, structure, builtinNames(vm).dataPublicName(), 0, offset);
    RELEASE_ASSERT(offset == extensionDataOffset);

    auto* constructor = JSExtensionConstructor::create(vm, JSExtensionConstructor::createStructure(vm, init.global, init.global->functionPrototype()), prototype);
    init.setPrototype(prototype);
    init.setStructure(structure);
    init.setConstructor(constructor);
}

JSValue constructMessagePackObject(VM& vm, JSObject* bunObject)
{
    using namespace MessagePack;

    JSGlobalObject* globalObject = bunObject->globalObject();
    auto* zigGlobalObject = defaultGlobalObject(globalObject);
    JSObject* object = constructEmptyObject(globalObject);
    object->putDirectNativeFunction(vm, globalObject, Identifier::fromString(vm, "encode"_s), 1, jsFunctionMessagePackEncode, ImplementationVisibility::Public, NoIntrinsic,
        PropertyAttribute::DontDelete | 0);
    object->putDirectNativeFunction(vm, globalObject, builtinNames(vm).decodePublicName(), 1, jsFunctionMessagePackDecode, ImplementationVisibility::Public, NoIntrinsic,
        PropertyAttribute::DontDelete | 0);
    object->putDirectNativeFunction(vm, globalObject, Identifier::fromString(vm, "decodeChunk"_s), 1, jsFunctionMessagePackDecodeChunk, ImplementationVisibility::Public, NoIntrinsic,
        PropertyAttribute::DontDelete | 0);
    object->putDirect(vm, Identifier::fromString(vm, "Extension"_s), zigGlobalObject->m_JSMessagePackExtensionClassStructure.constructor(zigGlobalObject),
        PropertyAttribute::DontDelete | 0);
    object->putDirect(vm, vm.propertyNames->toStringTagSymbol, jsNontrivialString(vm, "msgpack"_s),
        PropertyAttribute::DontEnum | PropertyAttribute::ReadOnly);
    return object;
}

} // namespace Bun
