// difffuzz: the bytes and error codes WTF's UTF-8 conversion gives for a fixed, generated set of inputs.
// Built once per variant (base, PR) from this one file. Two builds agree when their outputs are identical text.
// Each build also checks itself against WTF's ICU-macro converters, which the change does not touch.
//
//   difffuzz <kernel> <seed> <rounds>
//
// Output: one line "<inputs so far> <running hash>" per 20,000 inputs, and a last line with totals.
#define HAVE_CONFIG_H 1
#define BUILDING_WITH_CMAKE 1
#include "cmakeconfig.h"
#include <wtf/ExportMacros.h>
#undef new
#undef delete
#include <wtf/FastMalloc.h>
#include <wtf/Platform.h>
#include <wtf/SIMDUTF.h>
#include <wtf/text/CString.h>
#include <wtf/text/StringImpl.h>
#include <wtf/text/StringView.h>
#include <wtf/text/WTFString.h>
#include <wtf/unicode/UTF8Conversion.h>
#include <wtf/Vector.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

using namespace WTF;

static uint64_t running = 1469598103934665603ull;
static uint64_t inputs, comparisons, selfCheckFailures;

static void fold(uint64_t v)
{
    for (int i = 0; i < 8; ++i) {
        running = (running ^ (v & 0xff)) * 1099511628211ull;
        v >>= 8;
    }
}

static void foldBytes(std::span<const char8_t> bytes)
{
    fold(bytes.size());
    for (auto b : bytes)
        running = (running ^ b) * 1099511628211ull;
}

static void selfCheck(bool ok, const char* what, size_t n)
{
    if (ok)
        return;
    if (selfCheckFailures++ < 20)
        printf("SELFCHECK FAIL %s n=%zu\n", what, n);
}

static std::vector<uint8_t> reference, produced;

static const ConversionMode modes[] = { LenientConversion, StrictConversion, StrictConversionReplacingUnpairedSurrogatesWithFFFD };

static void check16(std::span<const char16_t> s)
{
    inputs++;
    size_t n = s.size();
    // Reference: WTF's replacing converter (U16_NEXT_OR_FFFD) and a well-formedness scan.
    reference.resize(n * 3 + 1);
    auto ref = Unicode::convertReplacingInvalidSequences(s, std::span<char8_t> { reinterpret_cast<char8_t*>(reference.data()), n * 3 });
    std::span<const char8_t> refBytes = ref.buffer;
    bool wellFormed = true;
    for (size_t i = 0; i < n; i++) {
        if (U16_IS_SURROGATE(s[i])) {
            if (U16_IS_SURROGATE_LEAD(s[i]) && i + 1 < n && U16_IS_TRAIL(s[i + 1])) {
                i++;
                continue;
            }
            wellFormed = false;
            break;
        }
    }

    for (auto mode : modes) {
        comparisons += 2;
        bool expectInvalid = mode == StrictConversion && !wellFormed;

        // Callback form.
        unsigned calls = 0;
        bool callbackMatches = false;
        auto r = StringImpl::tryGetUTF8ForCharacters([&](std::span<const char8_t> converted) {
            calls++;
            foldBytes(converted);
            callbackMatches = converted.size() == refBytes.size() && !memcmp(converted.data(), refBytes.data(), refBytes.size());
            selfCheck(!!converted.data(), "callback span has null data", converted.size());
            return converted.size();
        }, s, mode);
        if (!r) {
            fold(0xE0 + static_cast<unsigned>(r.error()));
            selfCheck(!calls, "callback called although the conversion failed", n);
            selfCheck(expectInvalid && r.error() == UTF8ConversionError::Invalid, "unexpected error (callback form)", n);
        } else {
            selfCheck(calls == 1, "callback not called exactly once", n);
            selfCheck(!expectInvalid, "strict conversion of ill-formed input succeeded (callback form)", n);
            selfCheck(callbackMatches, "bytes differ from the reference (callback form)", n);
        }

        // CString form.
        auto c = StringImpl::utf8ForCharacters(s, mode);
        if (!c) {
            fold(0xC0 + static_cast<unsigned>(c.error()));
            selfCheck(expectInvalid && c.error() == UTF8ConversionError::Invalid, "unexpected error (CString form)", n);
        } else {
            foldBytes(c->span());
            selfCheck(!c->isNull(), "null CString", n);
            selfCheck(!expectInvalid, "strict conversion of ill-formed input succeeded (CString form)", n);
            selfCheck(c->length() == refBytes.size() && !memcmp(c->span().data(), refBytes.data(), refBytes.size()), "bytes differ from the reference (CString form)", n);
            selfCheck(!c->spanIncludingNullTerminator().back(), "CString has no NUL terminator", n);
        }
    }
}

static void check8(std::span<const Latin1Character> s)
{
    inputs++;
    comparisons += 2;
    size_t n = s.size();
    reference.resize(n * 2 + 1);
    auto ref = Unicode::convert(s, std::span<char8_t> { reinterpret_cast<char8_t*>(reference.data()), n * 2 });
    std::span<const char8_t> refBytes = ref.buffer;

    unsigned calls = 0;
    bool callbackMatches = false;
    auto r = StringImpl::tryGetUTF8ForCharacters([&](std::span<const char8_t> converted) {
        calls++;
        foldBytes(converted);
        callbackMatches = converted.size() == refBytes.size() && !memcmp(converted.data(), refBytes.data(), refBytes.size());
        selfCheck(!!converted.data(), "callback span has null data (Latin-1)", converted.size());
        return converted.size();
    }, s);
    selfCheck(!!r && calls == 1, "Latin-1 callback form failed or did not call back once", n);
    selfCheck(callbackMatches, "bytes differ from the reference (Latin-1 callback form)", n);

    auto c = StringImpl::utf8ForCharacters(s);
    selfCheck(!!c, "Latin-1 CString form failed", n);
    if (c) {
        foldBytes(c->span());
        selfCheck(!c->isNull(), "null CString (Latin-1)", n);
        selfCheck(c->length() == refBytes.size() && !memcmp(c->span().data(), refBytes.data(), refBytes.size()), "bytes differ from the reference (Latin-1 CString form)", n);
        selfCheck(!c->spanIncludingNullTerminator().back(), "CString has no NUL terminator (Latin-1)", n);
    }
}

static void progress()
{
    if (!(inputs % 20000))
        printf("%llu %016llx\n", static_cast<unsigned long long>(inputs), static_cast<unsigned long long>(running));
}

int main(int argc, char** argv)
{
    const char* kernel = argc > 1 ? argv[1] : "default";
    uint64_t seed = argc > 2 ? strtoull(argv[2], 0, 0) : 1;
    uint64_t rounds = argc > 3 ? strtoull(argv[3], 0, 0) : 100000;
    if (strcmp(kernel, "default")) {
        auto* impl = simdutf::get_available_implementations()[kernel];
        if (!impl || !impl->supported_by_runtime_system()) {
            fprintf(stderr, "kernel %s not available\n", kernel);
            return 2;
        }
        simdutf::get_active_implementation() = impl;
    }
    printf("# kernel %s seed %llu rounds %llu\n", simdutf::get_active_implementation()->name().data(), static_cast<unsigned long long>(seed), static_cast<unsigned long long>(rounds));

    std::mt19937_64 rng(seed);
    auto pick16 = [&](unsigned cls) -> char16_t {
        switch (cls) {
        case 0: return 0x20 + rng() % 0x5f;
        case 1: return 0x80 + rng() % 0x780;
        case 2: {
            char16_t c;
            do {
                c = 0x800 + rng() % 0xf800;
            } while (c >= 0xd800 && c <= 0xdfff);
            return c;
        }
        case 3: return 0xd800 + rng() % 0x400;
        default: return 0xdc00 + rng() % 0x400;
        }
    };

    // Empty input, both widths. A null span and a non-null one.
    {
        static const char16_t one16[1] = { 'a' };
        static const Latin1Character one8[1] = { 'a' };
        check16({ });
        check16(std::span<const char16_t> { one16, 0 });
        check8({ });
        check8(std::span<const Latin1Character> { one8, 0 });
    }

    // A: every string of up to 6 units over a 6-symbol alphabet.
    {
        static const char16_t alphabet[] = { 'a', 0xe9, 0x65e5, 0xd83d, 0xde00, 0xffff };
        char16_t buf[8];
        for (size_t n = 1; n <= 6; n++) {
            uint64_t total = 1;
            for (size_t i = 0; i < n; i++)
                total *= 6;
            for (uint64_t code = 0; code < total; code++) {
                uint64_t c = code;
                for (size_t i = 0; i < n; i++) {
                    buf[i] = alphabet[c % 6];
                    c /= 6;
                }
                check16(std::span<const char16_t> { buf, n });
                progress();
            }
        }
    }

    // B: lengths around every boundary of the new code, with one or two surrogates at every position.
    {
        std::vector<char16_t> buf(2048);
        static const char16_t fillers[] = { 'a', 0xe9, 0x65e5 };
        static const char16_t specials[] = { 0xd800, 0xdbff, 0xdc00, 0xdfff };
        std::vector<size_t> lengths;
        for (size_t n = 1; n <= 70; n++)
            lengths.push_back(n);
        for (size_t n : { 127, 128, 129, 170, 171, 172, 255, 256, 257, 339, 340, 341, 342, 343, 344, 511, 512, 513, 1023, 1024, 1025 })
            lengths.push_back(n);
        for (char16_t filler : fillers) {
            for (size_t n : lengths) {
                size_t step = n > 70 ? 7 : 1;
                for (size_t i = 0; i < n; i += (i + step < n || i == n - 1) ? step : n - 1 - i) {
                    for (char16_t sp : specials) {
                        for (size_t k = 0; k < n; k++)
                            buf[k] = filler;
                        buf[i] = sp;
                        check16(std::span<const char16_t> { buf.data(), n });
                        progress();
                        if (i + 1 < n) {
                            for (char16_t sp2 : specials) {
                                buf[i + 1] = sp2;
                                check16(std::span<const char16_t> { buf.data(), n });
                                progress();
                            }
                            buf[i + 1] = filler;
                        }
                    }
                }
            }
        }
    }

    // C: random mixtures, random lengths and alignments.
    {
        std::vector<char16_t> storage(70000 + 64);
        for (uint64_t r = 0; r < rounds; r++) {
            size_t n;
            switch (rng() % 10) {
            case 0: n = rng() % 20; break;
            case 1: n = rng() % 70; break;
            case 2: n = 336 + rng() % 10; break;
            case 3: n = rng() % 400; break;
            case 4: n = 340 + rng() % 4; break;
            case 5: n = rng() % 1100; break;
            case 6: n = rng() % 5000; break;
            case 7: n = 1020 + rng() % 8; break;
            default: n = rng() % 700; break;
            }
            if (!(r % 4096))
                n = 65536 + rng() % 4000;
            size_t offset = rng() % 32;
            char16_t* p = storage.data() + offset;
            unsigned w[5];
            unsigned kind = rng() % 10;
            for (unsigned& x : w)
                x = rng() % 8;
            if (kind < 4) { w[3] = 0; w[4] = 0; }
            if (kind == 4) { w[0] = 60; }
            if (kind == 5) { w[2] = 60; }
            if (kind == 6) { w[3] = 20; w[4] = 20; }
            if (kind == 7) { w[0] = 200; w[1] = 0; w[2] = 0; w[3] = 1; w[4] = 0; }
            unsigned total = w[0] + w[1] + w[2] + w[3] + w[4];
            if (!total) { w[0] = 1; total = 1; }
            for (size_t i = 0; i < n; i++) {
                unsigned x = rng() % total;
                unsigned cls = 0;
                while (x >= w[cls]) { x -= w[cls]; cls++; }
                p[i] = pick16(cls);
                if (cls == 3 && i + 1 < n && (rng() & 1))
                    p[++i] = pick16(4);
            }
            check16(std::span<const char16_t> { p, n });
            progress();
        }
    }

    // D: Latin-1. Lengths around 16 and the inline buffer, one non-ASCII byte at every position, then random mixtures.
    {
        std::vector<uint8_t> storage(70000 + 64);
        std::vector<size_t> lengths;
        for (size_t n = 1; n <= 70; n++)
            lengths.push_back(n);
        for (size_t n : { 127, 128, 129, 255, 256, 257, 511, 512, 513, 514, 1023, 1024, 1025 })
            lengths.push_back(n);
        for (size_t n : lengths) {
            for (size_t i = 0; i <= n; i++) {
                for (uint8_t sp : { 0x80, 0xbf, 0xc0, 0xff }) {
                    memset(storage.data(), 'a', n);
                    if (i < n)
                        storage[i] = sp;
                    check8(std::span<const Latin1Character> { reinterpret_cast<const Latin1Character*>(storage.data()), n });
                    progress();
                }
            }
        }
        for (uint64_t r = 0; r < rounds; r++) {
            size_t n;
            switch (rng() % 8) {
            case 0: n = rng() % 20; break;
            case 1: n = rng() % 70; break;
            case 2: n = 510 + rng() % 5; break;
            case 3: n = rng() % 1100; break;
            case 4: n = rng() % 5000; break;
            case 5: n = 12 + rng() % 8; break;
            default: n = rng() % 300; break;
            }
            if (!(r % 4096))
                n = 65536 + rng() % 4000;
            size_t offset = rng() % 64;
            uint8_t* p = storage.data() + offset;
            unsigned density = rng() % 4 ? rng() % 101 : 0;
            for (size_t i = 0; i < n; i++)
                p[i] = (rng() % 100 < density) ? 0x80 + rng() % 0x80 : rng() % 0x80;
            // An ASCII prefix and a non-ASCII rest, as the ARM64 path splits them.
            if (!(rng() % 4) && n) {
                size_t prefix = rng() % n;
                for (size_t i = 0; i < prefix; i++)
                    p[i] &= 0x7f;
            }
            check8(std::span<const Latin1Character> { reinterpret_cast<const Latin1Character*>(p), n });
            progress();
        }
    }

    printf("done inputs %llu comparisons %llu hash %016llx selfcheck failures %llu\n", static_cast<unsigned long long>(inputs), static_cast<unsigned long long>(comparisons), static_cast<unsigned long long>(running), static_cast<unsigned long long>(selfCheckFailures));
    return selfCheckFailures ? 1 : 0;
}
