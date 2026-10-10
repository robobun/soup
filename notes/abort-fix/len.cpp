// len: what simdutf's utf8_length_from_utf16le counts for strings with an unpaired surrogate, per kernel.
#define HAVE_CONFIG_H 1
#define BUILDING_WITH_CMAKE 1
#include "cmakeconfig.h"
#include <wtf/ExportMacros.h>
#undef new
#undef delete
#include <wtf/FastMalloc.h>
#include <wtf/Platform.h>
#include <wtf/SIMDUTF.h>
#include <wtf/text/StringImpl.h>
#include <cstdio>
#include <cstring>
#include <vector>
using namespace WTF;
extern "C" volatile unsigned long stub_mallocs, stub_frees, stub_bytes;
static void one(const char* label, const std::vector<char16_t>& v)
{
    size_t measured = StringImpl::utf8LengthFromUTF16(std::span<const char16_t> { v.data(), v.size() });
    std::vector<char> out(v.size() * 3 + 16);
    size_t replaced = simdutf::convert_utf16le_to_utf8_with_replacement(v.data(), v.size(), out.data());
    printf("  %-44s units %4zu  measured %5zu  replaced %5zu  (%+ld)\n", label, v.size(), measured, replaced, (long)measured - (long)replaced);
}
int main(int argc, char** argv)
{
    const char* kernel = argc > 1 ? argv[1] : "default";
    if (strcmp(kernel, "default")) {
        auto* impl = simdutf::get_available_implementations()[kernel];
        if (!impl || !impl->supported_by_runtime_system()) { fprintf(stderr, "kernel %s not available\n", kernel); return 2; }
        simdutf::get_active_implementation() = impl;
    }
    printf("kernel %s\n", simdutf::get_active_implementation()->name().data());
    for (size_t n : { 0, 1, 7, 31, 63, 64, 65, 200 }) {
        for (char16_t s : { (char16_t)0xD800, (char16_t)0xDC00 }) {
            char label[96];
            std::vector<char16_t> v(n, 0x65E5);
            v.push_back(s);
            snprintf(label, sizeof label, "%zu CJK + %04X", n, (unsigned)s); one(label, v);
            v.push_back('a');
            snprintf(label, sizeof label, "%zu CJK + %04X + a", n, (unsigned)s); one(label, v);
            std::vector<char16_t> w(n, 0x65E5);
            w.insert(w.begin(), s);
            snprintf(label, sizeof label, "%04X + %zu CJK", (unsigned)s, n); one(label, w);
            if (n >= 2) {
                std::vector<char16_t> m(n, 0x65E5);
                m[n / 2] = s;
                snprintf(label, sizeof label, "%zu CJK, %04X in the middle", n, (unsigned)s); one(label, m);
            }
        }
    }
    return 0;
}
