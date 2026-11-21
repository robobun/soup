/*
 * Copyright (C) 2017 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. ``AS IS'' AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL APPLE INC. OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY
 * OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

#include "config.h"
#include "PromiseRejectionEvent.h"

#include "EventNames.h"
#include "GlobalEventScope.h"
#include "ModuleGraph.h"
#include "RejectedPromiseQueue.h"
#include "ZigGlobalObject.h"
#include <JavaScriptCore/JSPromise.h>
#include <wtf/TZoneMallocInlines.h>

namespace WebCore {
using namespace JSC;

WTF_MAKE_TZONE_ALLOCATED_IMPL(PromiseRejectionEvent);

PromiseRejectionEvent::PromiseRejectionEvent(const AtomString& type, const Init& initializer, IsTrusted isTrusted)
    : Event(PromiseRejectionEventInterfaceType, type, initializer, isTrusted)
    , m_promise(initializer.promise)
    , m_reason(initializer.reason)
{
}

PromiseRejectionEvent::~PromiseRejectionEvent() = default;

static Ref<PromiseRejectionEvent> dispatchToGlobal(Zig::GlobalObject* globalObject, const AtomString& type, JSPromise* promise, JSValue reason, bool cancelable)
{
    EnsureStillAliveScope keepPromise(promise);
    EnsureStillAliveScope keepReason(reason);
    PromiseRejectionEvent::Init init;
    init.cancelable = cancelable;
    init.promise = promise;
    init.reason = reason;
    Ref event = PromiseRejectionEvent::create(type, init, Event::IsTrusted::Yes);
    // The listeners are the realm's: they run as it, whichever Bun.ModuleGraph's code made the promise.
    Bun::ErrorHandlerContextScope inRealmsContext(globalObject, nullptr);
    globalObject->globalEventScope->dispatchEvent(event);
    return event;
}

} // namespace WebCore

using namespace WebCore;

// VirtualMachine::unhandled_rejection_owned, ahead of `process` and the --unhandled-rejections mode: the
// `unhandledrejection` listeners of the thread's global object. Returns whether one of them canceled the event,
// which makes the rejection handled. When the thread is told to stop meanwhile, the caller finds script forbidden.
extern "C" bool Bun__dispatchUnhandledRejectionEvent(JSC::JSGlobalObject* lexicalGlobalObject, JSC::EncodedJSValue encodedReason, JSC::EncodedJSValue encodedPromise)
{
    auto* globalObject = defaultGlobalObject(lexicalGlobalObject);
    auto& vm = JSC::getVM(globalObject);
    auto* promise = dynamicDowncast<JSC::JSPromise>(JSC::JSValue::decode(encodedPromise));
    if (!promise || vm.hasPendingTerminationException()) [[unlikely]]
        return false;
    auto& type = eventNames().unhandledrejectionEvent;
    if (!globalObject->globalEventScope->hasEventListeners(type))
        return false;

    // A promise that native code reports itself can have a handler already. That is no reason to keep it from the listeners.
    bool hadHandler = promise->isHandled();
    Ref event = dispatchToGlobal(globalObject, type, promise, JSC::JSValue::decode(encodedReason), true);
    if (vm.hasPendingTerminationException()) [[unlikely]]
        return false;

    // HTML reads the answer after the microtask checkpoint that follows a listener: `await null` and then
    // preventDefault() cancels, and a handler that a microtask of a listener attaches is not a late one. As for
    // every event that Bun dispatches itself, the checkpoint is one for the event and not one for each listener,
    // so a second listener runs before the microtasks of the first. With script on the stack (a rejection that
    // `expect(fn).toThrow()` reports) there is no checkpoint, as in HTML, and the answer is read at once.
    if (!vm.entryScope && globalObject->drainMicrotasks()) [[unlikely]]
        return false;

    bool canceled = event->defaultPrevented();
    uint8_t outcome = 0;
    if (canceled)
        outcome |= Bun::RejectedPromiseQueue::Canceled;
    if (!hadHandler && promise->isHandled())
        outcome |= Bun::RejectedPromiseQueue::HandledInEvent;
    if (outcome)
        globalObject->noteRejectionEventOutcome(promise, outcome);
    return canceled;
}

// VirtualMachine::handled_promise, ahead of `process`: the `rejectionhandled` listeners, if the thread asks them
// now. Returns whether an `unhandledrejection` listener had canceled this rejection. `process` never heard of
// that one.
extern "C" bool Bun__dispatchRejectionHandledEvent(JSC::JSGlobalObject* lexicalGlobalObject, JSC::EncodedJSValue encodedPromise, bool dispatch)
{
    auto* globalObject = defaultGlobalObject(lexicalGlobalObject);
    auto& vm = JSC::getVM(globalObject);
    auto* promise = dynamicDowncast<JSC::JSPromise>(JSC::JSValue::decode(encodedPromise));
    if (!promise || vm.hasPendingTerminationException()) [[unlikely]]
        return false;

    uint8_t outcome = globalObject->takeRejectionEventOutcome(promise);
    bool canceled = outcome & Bun::RejectedPromiseQueue::Canceled;
    // HTML: a handler that an `unhandledrejection` listener attaches is not a late one.
    if (outcome & Bun::RejectedPromiseQueue::HandledInEvent)
        return canceled;
    auto& type = eventNames().rejectionhandledEvent;
    if (dispatch && globalObject->globalEventScope->hasEventListeners(type))
        dispatchToGlobal(globalObject, type, promise, promise->result(), false);
    return canceled;
}
