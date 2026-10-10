// rows: instruction, allocation and free counts of WTF's UTF-8 conversion, one call per row.
// Built twice from this one file: against the pin's headers and libWTF.a (base), and against the
// patched headers with the patched objects linked ahead of the pin's libWTF.a (PR).
//
//   icount ./rows <kernel> [maxLength]
//
// Each row is one region between two int3 markers (see icount.c). stderr gets one line per row, in order:
//   <form>\t<label>\t<result>\t<mallocs>\t<frees>\t<bytes allocated>
// Forms:
//   cb16 / cb8   StringImpl::tryGetUTF8ForCharacters(callback, ...): the callback form
//   cs16 / cs8   StringImpl::utf8ForCharacters(...): the CString form behind String::utf8() and tryGetUTF8()
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
#include <wtf/Vector.h>
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

using namespace WTF;

extern "C" volatile unsigned long stub_mallocs, stub_frees, stub_bytes;

#if defined(__x86_64__)
static inline void marker() { __asm__ volatile("int3"); }
#else
extern "C" __attribute__((noinline)) void region_begin() { __asm__ volatile(""); }
extern "C" __attribute__((noinline)) void region_end() { __asm__ volatile(""); }
#endif

// The callback reads nothing itself, but the compiler has to assume that the bytes are read.
__attribute__((noinline)) static size_t consume(const char8_t* data, size_t size)
{
    __asm__ volatile("" : : "r"(data) : "memory");
    return size;
}

#define NOINL __attribute__((noinline))
#define RESULT(r) (r ? *r : static_cast<size_t>(-1) - static_cast<size_t>(r.error()))

NOINL static size_t cb16(std::span<const char16_t> s, ConversionMode mode)
{
    auto r = StringImpl::tryGetUTF8ForCharacters([](std::span<const char8_t> c) { return consume(c.data(), c.size()); }, s, mode);
    return RESULT(r);
}

NOINL static size_t cb8(std::span<const Latin1Character> s)
{
    auto r = StringImpl::tryGetUTF8ForCharacters([](std::span<const char8_t> c) { return consume(c.data(), c.size()); }, s);
    return RESULT(r);
}

// Called through pointers that the compiler cannot see through, so that the code of cs16() and cs8() does not
// depend on what the optimizer learns about the function behind them. That code is then the same in both builds.
static std::expected<UTF8CString, UTF8ConversionError> (*volatile utf8For16)(std::span<const char16_t>, ConversionMode) = &StringImpl::utf8ForCharacters;
static std::expected<UTF8CString, UTF8ConversionError> (*volatile utf8For8)(std::span<const Latin1Character>) = &StringImpl::utf8ForCharacters;

NOINL static size_t cs16(std::span<const char16_t> s, ConversionMode mode)
{
    auto r = utf8For16(s, mode);
    if (!r)
        return static_cast<size_t>(-1) - static_cast<size_t>(r.error());
    return consume(r->span().data(), r->length());
}

NOINL static size_t cs8(std::span<const Latin1Character> s)
{
    auto r = utf8For8(s);
    if (!r)
        return static_cast<size_t>(-1) - static_cast<size_t>(r.error());
    return consume(r->span().data(), r->length());
}

struct Row {
    std::string label;
    bool wide;
    std::vector<char16_t> v16;
    std::vector<uint8_t> v8;
    size_t length;
    ConversionMode mode { LenientConversion };
};

static std::vector<Row> rows;

static void add16(const std::string& label, size_t n, const std::vector<char16_t>& pattern, ConversionMode mode = LenientConversion, int lone = 0)
{
    Row r;
    r.label = label + " n=" + std::to_string(n);
    r.wide = true;
    r.v16.resize(n ? n : 1);
    for (size_t i = 0; i < n; ++i)
        r.v16[i] = pattern[i % pattern.size()];
    if (lone == 1)
        r.v16[n - 1] = 0xd800; // unpaired at the end
    if (lone == 2)
        r.v16[0] = 0xdc00; // unpaired at the start
    r.length = n;
    r.mode = mode;
    rows.push_back(std::move(r));
}

static void add8(const std::string& label, size_t n, const std::vector<uint8_t>& pattern)
{
    Row r;
    r.label = label + " n=" + std::to_string(n);
    r.wide = false;
    r.v8.resize(n ? n : 1);
    for (size_t i = 0; i < n; ++i)
        r.v8[i] = pattern[i % pattern.size()];
    r.length = n;
    rows.push_back(std::move(r));
}

int main(int argc, char** argv)
{
    const char* kernel = argc > 1 ? argv[1] : "default";
    size_t maxLength = argc > 2 ? strtoull(argv[2], 0, 0) : 65536;
    if (strcmp(kernel, "default")) {
        auto* impl = simdutf::get_available_implementations()[kernel];
        if (!impl || !impl->supported_by_runtime_system()) {
            fprintf(stderr, "kernel %s not available\n", kernel);
            return 2;
        }
        simdutf::get_active_implementation() = impl;
    }
    // Resolve the kernel before the first row, so that no row pays for the detection.
    fprintf(stderr, "# kernel %s\n", simdutf::get_active_implementation()->name().data());
#if !defined(__x86_64__)
    // For the trace reader: the regions are between the return of region_begin and the call of region_end.
    printf("region_begin=%p region_end=%p\n", (void*)&region_begin, (void*)&region_end);
    fflush(stdout);
#endif

    const std::vector<uint8_t> ascii8 = { 'a', 'b', 'c', ' ' }, eacute8 = { 0xe9 }, mixed8 = { 'c', 'a', 'f', 0xe9, ' ', 'a', 'u', ' ' };
    for (size_t n : { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 15, 16, 17, 24, 32, 64, 100, 400, 512, 513, 1000, 4096, 65536 }) {
        if (n > maxLength)
            continue;
        add8("latin1 ascii", n, ascii8);
        if (n) {
            add8("latin1 e-acute", n, eacute8);
            add8("latin1 mixed (1 in 8 non-ASCII)", n, mixed8);
        }
    }
    const std::vector<char16_t> ascii = { 'a', 'b', 'c', ' ' }, cyrillic = { 0x0436, 0x0438, 0x0432 }, cjk = { 0x65e5, 0x672c, 0x8a9e }, emoji = { 0xd83d, 0xde00 }, mixed = { 'a', 'b', 0xe9, 'c', 0x65e5, 'd', 'e', ' ' };
    for (size_t n : { 0, 1, 2, 8, 15, 16, 17, 32, 40, 100, 340, 341, 342, 400, 512, 513, 1000, 1024, 1025, 4096, 65536 }) {
        if (n > maxLength)
            continue;
        add16("utf16 ascii", n, ascii);
        if (!n)
            continue;
        add16("utf16 cyrillic", n, cyrillic);
        add16("utf16 cjk", n, cjk);
        add16("utf16 mixed", n, mixed);
        if (!(n & 1))
            add16("utf16 emoji", n, emoji);
    }
    for (size_t n : { 1, 8, 32, 341, 342, 1000, 4096 }) {
        if (n > maxLength)
            continue;
        add16("utf16 cjk + unpaired at end, lenient", n, cjk, LenientConversion, 1);
        add16("utf16 cjk + unpaired at end, strict", n, cjk, StrictConversion, 1);
        add16("utf16 cjk + unpaired at end, replacing", n, cjk, StrictConversionReplacingUnpairedSurrogatesWithFFFD, 1);
        add16("utf16 ascii + unpaired at start, lenient", n, ascii, LenientConversion, 2);
        add16("utf16 ascii + unpaired at start, strict", n, ascii, StrictConversion, 2);
    }

    // rows <kernel> <maxLength> time <rounds>: nanoseconds per call instead of regions for icount. Each row is timed
    // in <rounds> batches and the median batch is reported. One line per row on stdout: <form>\t<label>\t<ns per call>.
    if (argc > 4 && !strcmp(argv[3], "time")) {
        size_t rounds = strtoull(argv[4], 0, 0);
        const char* filter = argc > 5 ? argv[5] : nullptr; // "<form> <label>" has to contain it
        std::vector<double> samples(rounds);
        for (int form = 0; form < 2; ++form) {
            for (auto& row : rows) {
                if (filter && (std::string(form ? "cs" : "cb") + (row.wide ? "16 " : "8 ") + row.label).find(filter) == std::string::npos)
                    continue;
                size_t calls = std::max<size_t>(1, 40000 / (row.length + 40));
                // ROWS_SHIFT=<bytes>: a copy of the input that starts this many bytes into a fresh block, to move the
                // input against the output by a known amount (the low 12 bits of the two addresses matter to the CPU).
                static const size_t shift = getenv("ROWS_SHIFT") ? strtoull(getenv("ROWS_SHIFT"), 0, 0) : 0;
                std::vector<char16_t> shifted16;
                std::vector<uint8_t> shifted8;
                const char16_t* data16 = row.v16.data();
                const uint8_t* data8 = row.v8.data();
                if (shift) {
                    shifted16.resize(row.v16.size() + shift / 2 + 1);
                    memcpy(shifted16.data() + shift / 2, row.v16.data(), row.v16.size() * 2);
                    data16 = shifted16.data() + shift / 2;
                    shifted8.resize(row.v8.size() + shift + 1);
                    memcpy(shifted8.data() + shift, row.v8.data(), row.v8.size());
                    data8 = shifted8.data() + shift;
                }
                std::span<const char16_t> s16 { data16, row.length };
                std::span<const Latin1Character> s8 { reinterpret_cast<const Latin1Character*>(data8), row.length };
                auto fn16 = form ? cs16 : cb16;
                auto fn8 = form ? cs8 : cb8;
                volatile size_t sink = 0;
                for (size_t round = 0; round < rounds + 3; ++round) {
                    timespec t0, t1;
                    clock_gettime(CLOCK_MONOTONIC_RAW, &t0);
                    if (row.wide) {
                        for (size_t i = 0; i < calls; ++i)
                            sink = sink + fn16(s16, row.mode);
                    } else {
                        for (size_t i = 0; i < calls; ++i)
                            sink = sink + fn8(s8);
                    }
                    clock_gettime(CLOCK_MONOTONIC_RAW, &t1);
                    if (round >= 3)
                        samples[round - 3] = ((t1.tv_sec - t0.tv_sec) * 1e9 + (t1.tv_nsec - t0.tv_nsec)) / calls;
                }
                double fastest = *std::min_element(samples.begin(), samples.end());
                std::nth_element(samples.begin(), samples.begin() + rounds / 2, samples.end());
                printf("%s%s\t%s\t%.2f\t%.2f\n", form ? "cs" : "cb", row.wide ? "16" : "8", row.label.c_str(), samples[rounds / 2], fastest);
            }
        }
        return 0;
    }

    for (int form = 0; form < 2; ++form) {
        for (auto& row : rows) {
            size_t result;
            unsigned long m0, f0, b0;
            if (row.wide) {
                std::span<const char16_t> s { row.v16.data(), row.length };
                auto fn = form ? cs16 : cb16;
                volatile size_t warm = fn(s, row.mode);
                (void)warm;
                m0 = stub_mallocs; f0 = stub_frees; b0 = stub_bytes;
#if defined(__x86_64__)
                marker(); result = fn(s, row.mode); marker();
#else
                region_begin(); result = fn(s, row.mode); region_end();
#endif
            } else {
                std::span<const Latin1Character> s { reinterpret_cast<const Latin1Character*>(row.v8.data()), row.length };
                auto fn = form ? cs8 : cb8;
                volatile size_t warm = fn(s);
                (void)warm;
                m0 = stub_mallocs; f0 = stub_frees; b0 = stub_bytes;
#if defined(__x86_64__)
                marker(); result = fn(s); marker();
#else
                region_begin(); result = fn(s); region_end();
#endif
            }
            unsigned long m1 = stub_mallocs, f1 = stub_frees, b1 = stub_bytes;
            fprintf(stderr, "%s%s\t%s\t%zd\t%lu\t%lu\t%lu\n", form ? "cs" : "cb", row.wide ? "16" : "8", row.label.c_str(), static_cast<ssize_t>(result), m1 - m0, f1 - f0, b1 - b0);
        }
    }
    return 0;
}
