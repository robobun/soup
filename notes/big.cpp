// big: one conversion of a string of <units> x U+65E5, then <tail...> code units, in the given mode and form.
//   big <form: callback|cstring> <mode: lenient|strict|replacing> <units> [tail code units in hex...]
// Prints the result size, the last 8 bytes, whether a CString is NUL-terminated, and the peak resident set.
#define HAVE_CONFIG_H 1
#define BUILDING_WITH_CMAKE 1
#include "cmakeconfig.h"
#include <wtf/ExportMacros.h>
#undef new
#undef delete
#include <wtf/FastMalloc.h>
#include <wtf/Platform.h>
#include <wtf/text/CString.h>
#include <wtf/text/StringImpl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using namespace WTF;

static long peakRSSInMB()
{
    FILE* f = fopen("/proc/self/status", "r");
    char line[256];
    long kb = 0;
    while (fgets(line, sizeof line, f)) {
        if (!strncmp(line, "VmHWM:", 6))
            kb = strtol(line + 6, 0, 10);
    }
    fclose(f);
    return kb / 1024;
}

static void printTail(std::span<const char8_t> bytes)
{
    printf("size %zu tail", bytes.size());
    for (size_t i = bytes.size() > 8 ? bytes.size() - 8 : 0; i < bytes.size(); ++i)
        printf(" %02x", bytes[i]);
}

int main(int argc, char** argv)
{
    if (argc < 4)
        return 2;
    std::string form = argv[1], modeName = argv[2];
    size_t units = strtoull(argv[3], 0, 0);
    ConversionMode mode = modeName == "strict" ? StrictConversion : modeName == "replacing" ? StrictConversionReplacingUnpairedSurrogatesWithFFFD : LenientConversion;
    std::vector<char16_t> input(units, 0x65e5);
    for (int i = 4; i < argc; ++i)
        input.push_back(static_cast<char16_t>(strtoul(argv[i], 0, 16)));
    std::span<const char16_t> characters { input.data(), input.size() };
    printf("%zu code units, %s, %s: ", input.size(), form.c_str(), modeName.c_str());
    fflush(stdout);

    if (form == "callback") {
        unsigned calls = 0;
        auto result = StringImpl::tryGetUTF8ForCharacters([&](std::span<const char8_t> converted) {
            ++calls;
            printTail(converted);
            return converted.size();
        }, characters, mode);
        if (!result)
            printf("error %s", result.error() == UTF8ConversionError::OutOfMemory ? "OutOfMemory" : "Invalid");
        printf(", callback calls %u", calls);
    } else {
        auto result = StringImpl::utf8ForCharacters(characters, mode);
        if (!result)
            printf("error %s", result.error() == UTF8ConversionError::OutOfMemory ? "OutOfMemory" : "Invalid");
        else {
            printTail(result->span());
            printf(", NUL-terminated %d", !result->spanIncludingNullTerminator().back());
        }
    }
    printf(", peak RSS %ld MB\n", peakRSSInMB());
    return 0;
}
