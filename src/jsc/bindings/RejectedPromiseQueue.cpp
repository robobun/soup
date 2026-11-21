#include "root.h"
#include "RejectedPromiseQueue.h"
#include <JavaScriptCore/JSCellInlines.h>
#include <JavaScriptCore/JSGlobalObjectInlines.h>
#include <JavaScriptCore/JSWeakMap.h>
#include <JavaScriptCore/JSWeakSet.h>
#include <JavaScriptCore/SlotVisitorInlines.h>
#include <JavaScriptCore/WeakMapImplInlines.h>

namespace Bun {

NEVER_INLINE bool RejectedPromiseQueue::wasReported(JSC::JSPromise* promise)
{
    return m_reported->has(promise);
}

// Vector full, cell lock held. Handled promises go first, or a turn that never handles its newest rejection keeps them all until the drain.
NEVER_INLINE void RejectedPromiseQueue::makeRoom()
{
    size_t capacity = m_entries.capacity();
    if (capacity >= 64)
        m_entries.removeAllMatching([](const Entry& entry) { return isHandled(entry); });
    if (!capacity || m_entries.size() > capacity / 2)
        m_entries.reserveCapacity(std::max<size_t>(16, capacity * 2));
}

void RejectedPromiseQueue::markReported(JSC::JSGlobalObject* owner, JSC::JSPromise* promise)
{
    JSC::VM& vm = owner->vm();
    JSC::JSWeakSet* reported = m_reported.get();
    if (!reported) {
        reported = JSC::JSWeakSet::create(vm, owner->weakSetStructure());
        WTF::Locker locker { owner->cellLock() };
        m_reported.set(vm, owner, reported);
    }
    reported->add(vm, promise);
}

// Only a promise that the queue reported gets the task of a late handler, which takes the outcome out again.
NEVER_INLINE void RejectedPromiseQueue::noteEventOutcome(JSC::JSGlobalObject* owner, JSC::JSPromise* promise, uint8_t outcome)
{
    if (!m_reported || !wasReported(promise))
        return;
    JSC::VM& vm = owner->vm();
    JSC::JSWeakMap* outcomes = m_eventOutcomes.get();
    if (!outcomes) {
        outcomes = JSC::JSWeakMap::create(vm, owner->weakMapStructure());
        WTF::Locker locker { owner->cellLock() };
        m_eventOutcomes.set(vm, owner, outcomes);
    }
    outcomes->add(vm, promise, JSC::jsNumber(outcome));
}

NEVER_INLINE uint8_t RejectedPromiseQueue::takeEventOutcome(JSC::JSPromise* promise)
{
    JSC::JSWeakMap* outcomes = m_eventOutcomes.get();
    if (!outcomes)
        return 0;
    JSC::JSValue outcome = outcomes->get(promise);
    if (!outcome.isInt32())
        return 0;
    outcomes->remove(promise);
    return static_cast<uint8_t>(outcome.asInt32());
}

void RejectedPromiseQueue::drainTo(JSC::JSCell* owner, JSC::MarkedArgumentBuffer& promises, JSC::MarkedArgumentBuffer& rejectionOwners)
{
    WTF::Locker locker { owner->cellLock() };
    for (Entry& entry : m_entries) {
        if (isHandled(entry))
            continue;
        promises.append(entry.promise.get());
        rejectionOwners.append(entry.rejectionOwner.get());
    }
    m_entries.clear();
}

size_t RejectedPromiseQueue::hold(JSC::JSCell* owner)
{
    WTF::Locker locker { owner->cellLock() };
    size_t mark = m_held.size();
    m_held.appendVector(std::exchange(m_entries, {}));
    return mark;
}

void RejectedPromiseQueue::release(JSC::JSCell* owner, size_t mark)
{
    WTF::Locker locker { owner->cellLock() };
    WTF::Vector<Entry> entries;
    for (size_t i = mark; i < m_held.size(); i++) {
        if (!isHandled(m_held[i]))
            entries.append(m_held[i]);
    }
    entries.appendVector(m_entries);
    m_entries = WTF::move(entries);
    m_held.shrink(mark);
}

template<typename Visitor>
void RejectedPromiseQueue::visit(JSC::JSCell* owner, Visitor& visitor)
{
    WTF::Locker locker { owner->cellLock() };
    for (auto* entries : { &m_entries, &m_held }) {
        for (auto& entry : *entries) {
            visitor.append(entry.promise);
            visitor.append(entry.rejectionOwner);
        }
    }
    visitor.append(m_reported);
    visitor.append(m_eventOutcomes);
}

template void RejectedPromiseQueue::visit(JSC::JSCell*, JSC::AbstractSlotVisitor&);
template void RejectedPromiseQueue::visit(JSC::JSCell*, JSC::SlotVisitor&);

} // namespace Bun
