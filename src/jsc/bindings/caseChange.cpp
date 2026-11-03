// Implementation of the case functions of the Bun object: Bun.camelCase, Bun.capitalCase,
// Bun.constantCase, Bun.dotCase, Bun.kebabCase, Bun.pascalCase, Bun.snakeCase and Bun.trainCase.
//
// Each one gives the string that the function of the same name in the `change-case` package gives
// for the same input, with no options but `locale: false`:
// https://github.com/blakeembrey/change-case/blob/change-case%405.4.4/packages/change-case/src/index.ts
//
// The package finds the words of its input with three regular expressions and maps each word with
// String.prototype.toLowerCase and toUpperCase. Here one pass over the code units finds the words
// (Words). The class of a character comes from tables: the ones below for Latin-1, and
// caseChangeTables.h, which is generated from the classes of the regular expression engine, for the
// rest. A word that is all Latin-1 is mapped with tables too. Any other word goes to the two ICU
// functions that are behind those two methods, so the full case mappings apply: the uppercase of
// U+00DF is "SS", and a sigma at the end of a word is lowered to U+03C2.
//
// An 8-bit input is read twice and ICU is not called. The first pass (Measure) gives the length of
// the result and tells whether the result is the input, which is then returned as it is. The second
// (Write) fills a string of exactly that length. The result is 8-bit too, unless the uppercase of
// U+00B5 or of U+00FF takes it out of Latin-1.
//
// A 16-bit input is read once, into a buffer (Scratch) that starts on the stack, because the length
// of what ICU returns is not known before the call. The result is a copy of that buffer, 8-bit
// when every unit fits, or the input when the two are equal.

#include "root.h"
#include "caseChange.h"
#include "caseChangeTables.h"
#include "StringSizeLimit.h"
#include "VectorSizeLimit.h"

#include <algorithm>
#include <array>
#include <span>
#include <JavaScriptCore/ExceptionHelpers.h>
#include <unicode/utf16.h>
#include <wtf/ASCIICType.h>
#include <wtf/Vector.h>
#include <wtf/text/ASCIIFastPath.h>
#include <wtf/text/StringImpl.h>
#include <wtf/text/WTFString.h>

#if __has_include(<unicode/ustring.h>)
#include <unicode/ustring.h>
#else
// An SDK can have ICU without this header, as the one of macOS is without <unicode/unorm2.h> (bun_icu_normalize.cpp).
// The library still has the two functions under these names: WTF::StringImpl calls them.
#include <unicode/utypes.h>
extern "C" {
int32_t u_strToUpper(UChar* dest, int32_t destCapacity, const UChar* src, int32_t srcLength, const char* locale, UErrorCode* pErrorCode);
int32_t u_strToLower(UChar* dest, int32_t destCapacity, const UChar* src, int32_t srcLength, const char* locale, UErrorCode* pErrorCode);
}
#endif

namespace Bun {
namespace CaseChange {

// The first four have the values of caseChangeTables.h.
enum class CharacterClass : uint8_t {
    Separator = 0, // Neither a letter nor an ASCII digit.
    Upper = 1, // \p{Lu}
    Lower = 2, // \p{Ll}
    Letter = 3, // A letter that is neither: \p{Lt}, \p{Lm} and \p{Lo}.
    Digit = 4, // 0 to 9
};

enum class WordCase : uint8_t {
    Lower,
    Upper,
    // The first code unit in uppercase and the rest in lowercase.
    Capital,
};

struct CaseStyle {
    WordCase firstWord;
    WordCase otherWords;
    // 0: nothing goes between two words.
    uint8_t delimiter;
    // camelCase and pascalCase put "_" before a word that starts with a digit and is not the first, so
    // "version 1.2.10" is "version_1_2_10" and not "version1210".
    bool underscoreBeforeDigit;
};

static constexpr bool isLatin1Upper(unsigned character)
{
    return (character >= 'A' && character <= 'Z') || (character >= 0xC0 && character <= 0xDE && character != 0xD7);
}

static constexpr bool isLatin1Lower(unsigned character)
{
    return (character >= 'a' && character <= 'z') || character == 0xB5 || (character >= 0xDF && character <= 0xFF && character != 0xF7);
}

static constexpr std::array<CharacterClass, 256> makeLatin1Classes()
{
    std::array<CharacterClass, 256> classes {};
    for (unsigned character = 0; character < 256; ++character) {
        if (isLatin1Upper(character))
            classes[character] = CharacterClass::Upper;
        else if (isLatin1Lower(character))
            classes[character] = CharacterClass::Lower;
        else if (character >= '0' && character <= '9')
            classes[character] = CharacterClass::Digit;
        // The ordinal indicators U+00AA and U+00BA are \p{Lo}.
        else if (character == 0xAA || character == 0xBA)
            classes[character] = CharacterClass::Letter;
        else
            classes[character] = CharacterClass::Separator;
    }
    return classes;
}

static constexpr std::array<uint8_t, 256> makeLatin1Lower()
{
    std::array<uint8_t, 256> lower {};
    for (unsigned character = 0; character < 256; ++character)
        lower[character] = static_cast<uint8_t>(isLatin1Upper(character) ? character + 0x20 : character);
    return lower;
}

// U+00DF, U+00B5 and U+00FF map to themselves here. Their uppercase is not one Latin-1 character, and appendUpper() writes it.
static constexpr std::array<uint8_t, 256> makeLatin1Upper()
{
    std::array<uint8_t, 256> upper {};
    for (unsigned character = 0; character < 256; ++character) {
        const bool hasLatin1Upper = isLatin1Lower(character) && character != 0xDF && character != 0xB5 && character != 0xFF;
        upper[character] = static_cast<uint8_t>(hasLatin1Upper ? character - 0x20 : character);
    }
    return upper;
}

static constexpr auto kLatin1Classes = makeLatin1Classes();
static constexpr auto kLatin1Lower = makeLatin1Lower();
static constexpr auto kLatin1Upper = makeLatin1Upper();

static constexpr unsigned codeUnit(Latin1Character unit) { return unit.value; }
static constexpr unsigned codeUnit(char16_t unit) { return unit; }

// For a code point above U+00FF.
static ALWAYS_INLINE CharacterClass classOfCodePoint(char32_t codePoint)
{
    using namespace CaseChangeTables;
    if (codePoint >= kClassLimit)
        return CharacterClass::Separator;
    const unsigned block = kClassStage1[codePoint >> kClassBlockShift];
    const unsigned offset = codePoint & ((1u << kClassBlockShift) - 1);
    return static_cast<CharacterClass>((kClassStage2[block * kClassBlockBytes + (offset >> 2)] >> ((offset & 3) * 2)) & 3);
}

// The words of a string, in order. A word is a run of letters and ASCII digits, and a run is cut in two places:
// before an uppercase letter that follows a lowercase letter or a digit ("camel|Case", "v2|Beta"), and before the
// last uppercase letter of a run of them when a lowercase letter follows it ("XML|Http").
template<typename CharacterType>
class Words {
public:
    explicit Words(std::span<const CharacterType> input)
        : m_input(input)
    {
    }

    // Empty after the last word.
    std::span<const CharacterType> next()
    {
        const size_t length = m_input.size();
        size_t width = 1;
        CharacterClass previous = CharacterClass::Separator;
        for (; m_position < length; m_position += width) {
            previous = classAt(m_position, width);
            if (previous != CharacterClass::Separator)
                break;
        }
        if (m_position == length)
            return {};

        const size_t start = m_position;
        size_t previousStart = start;
        CharacterClass beforePrevious = CharacterClass::Separator;
        m_position += width;
        while (m_position < length) {
            const CharacterClass current = classAt(m_position, width);
            if (current == CharacterClass::Separator)
                break;
            if (current == CharacterClass::Upper && (previous == CharacterClass::Lower || previous == CharacterClass::Digit))
                break;
            if (current == CharacterClass::Lower && previous == CharacterClass::Upper && beforePrevious == CharacterClass::Upper) {
                m_position = previousStart;
                break;
            }
            beforePrevious = previous;
            previous = current;
            previousStart = m_position;
            m_position += width;
        }
        return m_input.subspan(start, m_position - start);
    }

private:
    // `width` is the number of code units of the character at `index`.
    CharacterClass classAt(size_t index, size_t& width) const
    {
        const unsigned unit = codeUnit(m_input[index]);
        width = 1;
        if (unit < 0x100)
            return kLatin1Classes[unit];
        if (!U16_IS_SURROGATE(unit))
            return classOfCodePoint(unit);
        if (U16_IS_SURROGATE_LEAD(unit) && index + 1 < m_input.size()) {
            const unsigned trail = codeUnit(m_input[index + 1]);
            if (U16_IS_TRAIL(trail)) {
                width = 2;
                return classOfCodePoint(U16_GET_SUPPLEMENTARY(unit, trail));
            }
        }
        // A surrogate without its other half.
        return CharacterClass::Separator;
    }

    std::span<const CharacterType> m_input;
    size_t m_position { 0 };
};

// The first pass over an 8-bit input: the length of the result, and whether the result is the input.
struct Measure {
    std::span<const Latin1Character> input;
    size_t length { 0 };
    bool isInput { true };
    // The result has a character outside of Latin-1.
    bool needs16Bit { false };

    void append(Latin1Character unit)
    {
        isInput = isInput && length < input.size() && input[length] == unit;
        ++length;
    }

    void appendNonLatin1(char16_t)
    {
        needs16Bit = true;
        isInput = false;
        ++length;
    }
};

// The second pass over an 8-bit input: fills a buffer that has the length the first pass gave.
template<typename OutputCharacter>
struct Write {
    std::span<OutputCharacter> output;
    size_t length { 0 };

    void append(Latin1Character unit)
    {
        output[length++] = static_cast<OutputCharacter>(unit.value);
    }

    void appendNonLatin1(char16_t unit)
    {
        // Measure asks for a 16-bit buffer when the result has such a character.
        RELEASE_ASSERT(sizeof(OutputCharacter) == sizeof(char16_t));
        output[length++] = static_cast<OutputCharacter>(unit);
    }
};

using ICUCaseMapping = int32_t (*)(UChar*, int32_t, const UChar*, int32_t, const char*, UErrorCode*);

// The result for a 16-bit input. The buffer is on the stack until the result is longer than that.
class Scratch {
public:
    bool failed() const { return m_failed; }
    std::span<const char16_t> units() const { return m_units.span(); }

    void append(char16_t unit)
    {
        if (reserve(1)) [[likely]]
            m_units.append(unit);
    }

    void appendNonLatin1(char16_t unit) { append(unit); }

    // Appends what `map` makes of `characters`. ICU takes the characters before and after a letter into account,
    // so the caller passes exactly the units that change-case passes to toLowerCase() or toUpperCase().
    void appendMapped(std::span<const char16_t> characters, ICUCaseMapping map)
    {
        const size_t start = m_units.size();
        // Most mappings keep the length. ICU reports the length it needs when this is too short.
        size_t capacity = characters.size();
        while (true) {
            if (!reserve(capacity)) [[unlikely]]
                return;
            m_units.grow(start + capacity);
            UErrorCode status = U_ZERO_ERROR;
            const int32_t mapped = map(m_units.mutableSpan().subspan(start).data(), static_cast<int32_t>(capacity), characters.data(), static_cast<int32_t>(characters.size()), "", &status);
            if (status == U_BUFFER_OVERFLOW_ERROR && mapped > 0 && static_cast<size_t>(mapped) > capacity) {
                m_units.shrink(start);
                capacity = static_cast<size_t>(mapped);
                continue;
            }
            if (U_FAILURE(status) || mapped < 0 || static_cast<size_t>(mapped) > capacity) [[unlikely]] {
                m_units.shrink(start);
                m_failed = true;
                return;
            }
            m_units.shrink(start + static_cast<size_t>(mapped));
            return;
        }
    }

private:
    // Makes room for `count` more units. The capacity doubles up to the most that a Vector holds, so that a
    // result is refused only when it is longer than that, and not when one more doubling would be.
    bool reserve(size_t count)
    {
        if (m_failed) [[unlikely]]
            return false;
        const size_t needed = m_units.size() + count;
        if (needed <= m_units.capacity()) [[likely]]
            return true;
        const size_t limit = maxVectorSize<char16_t>();
        if (needed > limit || !m_units.tryReserveCapacity(std::min(limit, std::max(needed, m_units.capacity() * 2)))) [[unlikely]] {
            m_failed = true;
            return false;
        }
        return true;
    }

    Vector<char16_t, 256> m_units;
    bool m_failed { false };
};

template<typename CharacterType, typename Sink>
static void appendLower(Sink& sink, std::span<const CharacterType> characters)
{
    if constexpr (sizeof(CharacterType) == sizeof(char16_t)) {
        if (!WTF::charactersAreAllLatin1(characters)) {
            sink.appendMapped(characters, u_strToLower);
            return;
        }
    }
    for (const CharacterType unit : characters)
        sink.append(kLatin1Lower[codeUnit(unit)]);
}

template<typename CharacterType, typename Sink>
static void appendUpper(Sink& sink, std::span<const CharacterType> characters)
{
    if constexpr (sizeof(CharacterType) == sizeof(char16_t)) {
        if (!WTF::charactersAreAllLatin1(characters)) {
            sink.appendMapped(characters, u_strToUpper);
            return;
        }
    }
    for (const CharacterType unit : characters) {
        switch (codeUnit(unit)) {
        case 0xDF:
            sink.append('S');
            sink.append('S');
            break;
        case 0xB5:
            sink.appendNonLatin1(0x039C);
            break;
        case 0xFF:
            sink.appendNonLatin1(0x0178);
            break;
        default:
            sink.append(kLatin1Upper[codeUnit(unit)]);
        }
    }
}

template<typename CharacterType, typename Sink>
static void convert(std::span<const CharacterType> input, const CaseStyle& style, Sink& sink)
{
    Words<CharacterType> words(input);
    bool isFirstWord = true;
    for (auto word = words.next(); !word.empty(); word = words.next()) {
        if (!isFirstWord && style.delimiter)
            sink.append(style.delimiter);
        switch (isFirstWord ? style.firstWord : style.otherWords) {
        case WordCase::Lower:
            appendLower(sink, word);
            break;
        case WordCase::Upper:
            appendUpper(sink, word);
            break;
        case WordCase::Capital:
            // change-case takes word[0] for the first character. That is one code unit, so half of a character outside
            // of the Basic Multilingual Plane. Neither half has another case, and such a first character stays as it is.
            if (style.underscoreBeforeDigit && !isFirstWord && isASCIIDigit(codeUnit(word[0]))) {
                sink.append('_');
                sink.append(static_cast<uint8_t>(codeUnit(word[0])));
            } else
                appendUpper(sink, word.first(1));
            appendLower(sink, word.subspan(1));
            break;
        }
        isFirstWord = false;
    }
}

template<typename OutputCharacter>
static RefPtr<WTF::StringImpl> writeLatin1(std::span<const Latin1Character> input, const CaseStyle& style, size_t length)
{
    std::span<OutputCharacter> output;
    RefPtr<WTF::StringImpl> result = WTF::StringImpl::tryCreateUninitialized(length, output);
    if (!result) [[unlikely]]
        return nullptr;
    Write<OutputCharacter> write { output };
    convert(input, style, write);
    RELEASE_ASSERT(write.length == length);
    return result;
}

// Returns nullptr after it throws.
static JSC::JSString* changeCaseLatin1(JSC::JSGlobalObject* globalObject, JSC::JSString* string, std::span<const Latin1Character> input, const CaseStyle& style)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);

    Measure measure { input };
    convert(input, style, measure);
    if (measure.isInput && measure.length == input.size())
        return string;

    RefPtr<WTF::StringImpl> result;
    if (!exceedsStringLimit(measure.length))
        result = measure.needs16Bit ? writeLatin1<char16_t>(input, style, measure.length) : writeLatin1<Latin1Character>(input, style, measure.length);
    if (!result) [[unlikely]] {
        throwOutOfMemoryError(globalObject, scope);
        return nullptr;
    }
    return JSC::jsString(vm, WTF::String(result.releaseNonNull()));
}

// Returns nullptr after it throws.
static JSC::JSString* changeCaseUTF16(JSC::JSGlobalObject* globalObject, JSC::JSString* string, std::span<const char16_t> input, const CaseStyle& style)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);

    Scratch scratch;
    convert(input, style, scratch);
    const auto units = scratch.units();
    if (!scratch.failed() && equalSpans(units, input))
        return string;

    RefPtr<WTF::StringImpl> result;
    if (!scratch.failed() && !exceedsStringLimit(units.size())) {
        if (WTF::charactersAreAllLatin1(units)) {
            std::span<Latin1Character> output;
            result = WTF::StringImpl::tryCreateUninitialized(units.size(), output);
            if (result)
                WTF::StringImpl::copyCharacters(output, units);
        } else {
            std::span<char16_t> output;
            result = WTF::StringImpl::tryCreateUninitialized(units.size(), output);
            if (result)
                WTF::StringImpl::copyCharacters(output, units);
        }
    }
    if (!result) [[unlikely]] {
        throwOutOfMemoryError(globalObject, scope);
        return nullptr;
    }
    return JSC::jsString(vm, WTF::String(result.releaseNonNull()));
}

static JSC::EncodedJSValue changeCase(JSC::JSGlobalObject* globalObject, JSC::CallFrame* callFrame, const CaseStyle& style)
{
    auto& vm = JSC::getVM(globalObject);
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSC::JSString* const string = callFrame->argument(0).toString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    const auto view = string->view(globalObject);
    RETURN_IF_EXCEPTION(scope, {});

    JSC::JSString* const result = view->is8Bit()
        ? changeCaseLatin1(globalObject, string, view->span8(), style)
        : changeCaseUTF16(globalObject, string, view->span16(), style);
    RETURN_IF_EXCEPTION(scope, {});
    return JSC::JSValue::encode(result);
}

static constexpr CaseStyle kCamelCase { WordCase::Lower, WordCase::Capital, 0, true };
static constexpr CaseStyle kCapitalCase { WordCase::Capital, WordCase::Capital, ' ', false };
static constexpr CaseStyle kConstantCase { WordCase::Upper, WordCase::Upper, '_', false };
static constexpr CaseStyle kDotCase { WordCase::Lower, WordCase::Lower, '.', false };
static constexpr CaseStyle kKebabCase { WordCase::Lower, WordCase::Lower, '-', false };
static constexpr CaseStyle kPascalCase { WordCase::Capital, WordCase::Capital, 0, true };
static constexpr CaseStyle kSnakeCase { WordCase::Lower, WordCase::Lower, '_', false };
static constexpr CaseStyle kTrainCase { WordCase::Capital, WordCase::Capital, '-', false };

} // namespace CaseChange

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunCamelCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kCamelCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunCapitalCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kCapitalCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunConstantCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kConstantCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunDotCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kDotCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunKebabCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kKebabCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunPascalCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kPascalCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunSnakeCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kSnakeCase);
}

JSC_DEFINE_HOST_FUNCTION(jsFunctionBunTrainCase, (JSC::JSGlobalObject * globalObject, JSC::CallFrame* callFrame))
{
    return CaseChange::changeCase(globalObject, callFrame, CaseChange::kTrainCase);
}

} // namespace Bun
