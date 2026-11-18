// The compression function of BLAKE3 for several inputs at a time, one in each 32-bit lane. Derived from the BLAKE3 team's code (LICENSE.md).

// One target for each width of vector. What a target has beyond its width is of no use here, and on Arm the baseline has it all.
#undef HWY_DISABLED_TARGETS
#ifdef __APPLE__
#define HWY_DISABLED_TARGETS (HWY_ALL_SVE | HWY_NEON_BF16 | HWY_SSE4 | (HWY_AVX3 - 1))
#else
#define HWY_DISABLED_TARGETS (HWY_ALL_SVE | HWY_NEON | HWY_NEON_BF16 | HWY_SSE4 | (HWY_AVX3 - 1))
#endif
#ifndef __OPTIMIZE__
#error "Unless hwy::ChosenTarget::GetIndex() is inlined, the linker may keep that of a file with other targets."
#endif

#undef HWY_TARGET_INCLUDE
#define HWY_TARGET_INCLUDE "highway_blake3.cpp"
#include <hwy/foreach_target.h>
#include <hwy/highway.h>
#include "highway_dispatch.h"

#include <array>
#include <stddef.h>
#include <stdint.h>

HWY_BEFORE_NAMESPACE();
namespace bun {
namespace HWY_NAMESPACE {

namespace hn = hwy::HWY_NAMESPACE;

static constexpr size_t kBlock = 64;
static constexpr size_t kChainingValue = 32;
static constexpr uint32_t kIV[4] = { 0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A };
// The message words that each round takes, in order.
static constexpr uint8_t kSchedule[7][16] = {
    { 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15 },
    { 2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8 },
    { 3, 4, 10, 12, 13, 2, 7, 14, 6, 5, 9, 0, 11, 15, 8, 1 },
    { 10, 7, 12, 9, 14, 3, 13, 15, 4, 0, 11, 2, 5, 8, 1, 6 },
    { 12, 13, 9, 11, 15, 10, 14, 8, 7, 2, 5, 3, 0, 1, 6, 4 },
    { 9, 14, 11, 5, 8, 12, 15, 1, 13, 3, 0, 10, 2, 6, 4, 7 },
    { 11, 15, 5, 0, 1, 9, 8, 6, 14, 10, 2, 12, 3, 4, 7, 13 },
};

// A rotation by whole bytes is a shuffle where there is no instruction that rotates.
template<class D, class V = hn::Vec<D>>
static HWY_INLINE V RotateRight16(D d, V v)
{
#if HWY_TARGET <= HWY_AVX3
    (void)d;
    return hn::RotateRight<16>(v);
#else
    const hn::Repartition<uint16_t, D> halves;
    return hn::BitCast(d, hn::Reverse2(halves, hn::BitCast(halves, v)));
#endif
}

template<class D, class V = hn::Vec<D>>
static HWY_INLINE V RotateRight8(D d, V v)
{
#if HWY_TARGET <= HWY_AVX3
    (void)d;
    return hn::RotateRight<8>(v);
#else
    const hn::Repartition<uint8_t, D> bytes;
    const auto from = hn::Dup128VecFromValues(bytes, 1, 2, 3, 0, 5, 6, 7, 4, 9, 10, 11, 8, 13, 14, 15, 12);
    return hn::BitCast(d, hn::TableLookupBytes(hn::BitCast(bytes, v), from));
#endif
}

template<class D, class V = hn::Vec<D>>
static HWY_INLINE void G(D d, V& a, V& b, V& c, V& e, V x, V y)
{
    a = hn::Add(hn::Add(a, b), x);
    e = RotateRight16(d, hn::Xor(e, a));
    c = hn::Add(c, e);
    b = hn::RotateRight<12>(hn::Xor(b, c));
    a = hn::Add(hn::Add(a, b), y);
    e = RotateRight8(d, hn::Xor(e, a));
    c = hn::Add(c, e);
    b = hn::RotateRight<7>(hn::Xor(b, c));
}

// `rows[i]` has as many words of input `i` as there are lanes. Afterwards `rows[i]` has word `i` of each input.
template<class D, class V = hn::Vec<D>>
static HWY_INLINE void Transpose(D d, V* HWY_RESTRICT rows)
{
    constexpr size_t kLanes = HWY_MAX_LANES_D(D);
    const hn::Repartition<uint64_t, D> d64;
    // Within each 128 bits.
    V quads[kLanes];
    for (size_t i = 0; i < kLanes; i += 4) {
        const auto a = hn::BitCast(d64, hn::InterleaveLower(d, rows[i], rows[i + 1]));
        const auto b = hn::BitCast(d64, hn::InterleaveUpper(d, rows[i], rows[i + 1]));
        const auto c = hn::BitCast(d64, hn::InterleaveLower(d, rows[i + 2], rows[i + 3]));
        const auto e = hn::BitCast(d64, hn::InterleaveUpper(d, rows[i + 2], rows[i + 3]));
        quads[i] = hn::BitCast(d, hn::InterleaveLower(d64, a, c));
        quads[i + 1] = hn::BitCast(d, hn::InterleaveUpper(d64, a, c));
        quads[i + 2] = hn::BitCast(d, hn::InterleaveLower(d64, b, e));
        quads[i + 3] = hn::BitCast(d, hn::InterleaveUpper(d64, b, e));
    }
    if constexpr (kLanes == 4) {
        for (size_t i = 0; i < 4; i++)
            rows[i] = quads[i];
    } else if constexpr (kLanes == 8) {
        for (size_t i = 0; i < 4; i++) {
            rows[i] = hn::ConcatLowerLower(d, quads[4 + i], quads[i]);
            rows[4 + i] = hn::ConcatUpperUpper(d, quads[4 + i], quads[i]);
        }
    } else {
        static_assert(kLanes == 16);
        // Of two vectors, their first and third 128 bits, and their second and fourth.
        const auto first_and_third = hn::SetTableIndices(d64, std::array<int64_t, 8> { 0, 1, 8, 9, 4, 5, 12, 13 }.data());
        const auto second_and_fourth = hn::SetTableIndices(d64, std::array<int64_t, 8> { 2, 3, 10, 11, 6, 7, 14, 15 }.data());
        for (size_t i = 0; i < 4; i++) {
            const auto a = hn::BitCast(d64, quads[i]), b = hn::BitCast(d64, quads[4 + i]);
            const auto c = hn::BitCast(d64, quads[8 + i]), e = hn::BitCast(d64, quads[12 + i]);
            const auto ab = hn::TwoTablesLookupLanes(d64, a, b, first_and_third), ce = hn::TwoTablesLookupLanes(d64, c, e, first_and_third);
            rows[i] = hn::BitCast(d, hn::ConcatLowerLower(d64, ce, ab));
            rows[8 + i] = hn::BitCast(d, hn::ConcatUpperUpper(d64, ce, ab));
            const auto ab_next = hn::TwoTablesLookupLanes(d64, a, b, second_and_fourth), ce_next = hn::TwoTablesLookupLanes(d64, c, e, second_and_fourth);
            rows[4 + i] = hn::BitCast(d, hn::ConcatLowerLower(d64, ce_next, ab_next));
            rows[12 + i] = hn::BitCast(d, hn::ConcatUpperUpper(d64, ce_next, ab_next));
        }
    }
}

template<class D, class V = hn::Vec<D>>
static HWY_INLINE void Round(D d, V* HWY_RESTRICT v, const V* HWY_RESTRICT m, const uint8_t* schedule)
{
    G(d, v[0], v[4], v[8], v[12], m[schedule[0]], m[schedule[1]]);
    G(d, v[1], v[5], v[9], v[13], m[schedule[2]], m[schedule[3]]);
    G(d, v[2], v[6], v[10], v[14], m[schedule[4]], m[schedule[5]]);
    G(d, v[3], v[7], v[11], v[15], m[schedule[6]], m[schedule[7]]);
    G(d, v[0], v[5], v[10], v[15], m[schedule[8]], m[schedule[9]]);
    G(d, v[1], v[6], v[11], v[12], m[schedule[10]], m[schedule[11]]);
    G(d, v[2], v[7], v[8], v[13], m[schedule[12]], m[schedule[13]]);
    G(d, v[3], v[4], v[9], v[14], m[schedule[14]], m[schedule[15]]);
}

// Hashes `count` inputs, which is not more than there are lanes. The lanes after them hash the last input again.
template<class D, class V = hn::Vec<D>>
static HWY_INLINE void HashGroup(D d, const uint8_t* HWY_RESTRICT input, size_t count, size_t blocks, const uint32_t* HWY_RESTRICT key, uint64_t counter,
    bool increment_counter, uint32_t flags, uint32_t flags_start, uint32_t flags_end, uint8_t* HWY_RESTRICT out)
{
    constexpr size_t kLanes = HWY_MAX_LANES_D(D);
    const hn::Repartition<uint8_t, D> bytes;
    const uint8_t* inputs[kLanes];
    HWY_ALIGN uint32_t counter_low[kLanes], counter_high[kLanes];
    for (size_t lane = 0; lane < kLanes; lane++) {
        const size_t index = HWY_MIN(lane, count - 1);
        inputs[lane] = input + index * blocks * kBlock;
        const uint64_t lane_counter = counter + (increment_counter ? index : 0);
        counter_low[lane] = static_cast<uint32_t>(lane_counter);
        counter_high[lane] = static_cast<uint32_t>(lane_counter >> 32);
    }
    V h[8];
    for (size_t i = 0; i < 8; i++)
        h[i] = hn::Set(d, key[i]);
    for (size_t block = 0; block < blocks; block++) {
        V m[16];
        for (size_t word = 0; word < 16; word += kLanes) {
            for (size_t lane = 0; lane < kLanes; lane++)
                m[word + lane] = hn::BitCast(d, hn::LoadU(bytes, inputs[lane] + block * kBlock + 4 * word));
            Transpose(d, m + word);
        }
        const uint32_t block_flags = flags | (block == 0 ? flags_start : 0) | (block == blocks - 1 ? flags_end : 0);
        V v[16] = {
            h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7],
            hn::Set(d, kIV[0]), hn::Set(d, kIV[1]), hn::Set(d, kIV[2]), hn::Set(d, kIV[3]),
            hn::Load(d, counter_low), hn::Load(d, counter_high), hn::Set(d, uint32_t { kBlock }), hn::Set(d, block_flags)
        };
        // Seven copies of a round are 5 KB more for each width of each target, and 4% faster at most.
        HWY_UNROLL(1)
        for (const uint8_t* schedule : kSchedule)
            Round(d, v, m, schedule);
        for (size_t i = 0; i < 8; i++)
            h[i] = hn::Xor(v[i], v[i + 8]);
    }
    HWY_ALIGN uint32_t words[8][kLanes];
    for (size_t i = 0; i < 8; i++)
        hn::Store(h[i], d, words[i]);
    for (size_t lane = 0; lane < count; lane++) {
        uint32_t chaining_value[8];
        for (size_t i = 0; i < 8; i++)
            chaining_value[i] = words[i][lane];
        hwy::CopyBytes<kChainingValue>(chaining_value, out + lane * kChainingValue);
    }
}

// The inputs that are not hashed yet, and where their chaining values go.
struct Rest {
    const uint8_t* input;
    uint8_t* out;
    size_t count;
    uint64_t counter;
};

// Hashes groups of as many inputs as `d` has lanes, and a last group of `least` inputs or more.
template<class D>
static HWY_INLINE void HashGroups(D d, Rest& rest, size_t least, size_t blocks, const uint32_t* HWY_RESTRICT key, bool increment_counter, uint32_t flags,
    uint32_t flags_start, uint32_t flags_end)
{
    while (rest.count >= least) {
        const size_t group = HWY_MIN(rest.count, HWY_MAX_LANES_D(D));
        HashGroup(d, rest.input, group, blocks, key, rest.counter, increment_counter, flags, flags_start, flags_end, rest.out);
        rest.input += group * blocks * kBlock;
        rest.out += group * kChainingValue;
        rest.count -= group;
        if (increment_counter)
            rest.counter += group;
    }
}

// blake3_hash_many of the BLAKE3 team's C code, for inputs that are adjacent: each is `blocks` blocks of 64 bytes and gives 32 bytes of `out`.
static void Blake3HashMany(const uint8_t* HWY_RESTRICT input, size_t count, size_t blocks, const uint32_t* HWY_RESTRICT key, uint64_t counter,
    bool increment_counter, uint32_t flags, uint32_t flags_start, uint32_t flags_end, uint8_t* HWY_RESTRICT out)
{
    Rest rest { input, out, count, counter };
#if HWY_MAX_BYTES >= 64
    HashGroups(hn::CappedTag<uint32_t, 16>(), rest, 16, blocks, key, increment_counter, flags, flags_start, flags_end);
#endif
    // A vector of 256 bits, or the only one, also takes the group that is not full. With AVX2 a 128-bit group for it is 3 KB more and no faster.
    HashGroups(hn::CappedTag<uint32_t, HWY_MIN(HWY_MAX_BYTES / 4, 8)>(), rest, 1, blocks, key, increment_counter, flags, flags_start, flags_end);
}

// NOLINTNEXTLINE(google-readability-namespace-comments)
} // namespace HWY_NAMESPACE
} // namespace bun
HWY_AFTER_NAMESPACE();

#if HWY_ONCE
namespace bun {
HWY_EXPORT(Blake3HashMany);

extern "C" void highway_blake3_hash_many(const uint8_t* input, size_t count, size_t blocks, const uint32_t* key, uint64_t counter,
    bool increment_counter, uint32_t flags, uint32_t flags_start, uint32_t flags_end, uint8_t* out)
{
    BUN_HWY_DISPATCH(Blake3HashMany)(input, count, blocks, key, counter, increment_counter, flags, flags_start, flags_end, out);
}
} // namespace bun
#endif
