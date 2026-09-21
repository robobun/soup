#include "config.h"
#include "WebLocks.h"

#include "ActiveDOMObject.h"
#include "ScriptExecutionContext.h"
#include "ZigGlobalObject.h"
#include <JavaScriptCore/ArgList.h>
#include <JavaScriptCore/CallData.h>
#include <JavaScriptCore/ObjectConstructor.h>
#include <JavaScriptCore/Strong.h>
#include <JavaScriptCore/StrongInlines.h>
#include <JavaScriptCore/Weak.h>
#include <JavaScriptCore/WeakInlines.h>
#include <algorithm>
#include <atomic>
#include <utility>
#include <wtf/Deque.h>
#include <wtf/HashMap.h>
#include <wtf/Lock.h>
#include <wtf/NeverDestroyed.h>
#include <wtf/ProcessID.h>
#include <wtf/TZoneMallocInlines.h>
#include <wtf/Threading.h>
#include <wtf/Vector.h>
#include <wtf/text/MakeString.h>
#include <wtf/text/StringHash.h>

namespace WebCore {

using namespace JSC;

enum class WebLockMode : uint8_t {
    Exclusive,
    Shared,
};

// What the registry tells a client. The first three are forwarded to the JavaScript dispatcher
// with these values (see internal/web_locks.ts); the last two stay native.
enum class WebLockEvent : uint8_t {
    Granted = 0,
    NotAvailable = 1,
    Broken = 2,
    RefEventLoop = 3,
    UnrefEventLoop = 4,
};

struct WebLockRequest {
    uint64_t id;
    uint64_t clientKey;
    // Where the client is told about the request, and the thread that is.
    ScriptExecutionContextIdentifier contextId;
    BunLoopKind loopKind;
    uint32_t threadUID;
    WebLockMode mode;
    // Pending only: the request holds a keep-alive on its thread's event loop.
    bool keepsEventLoopAlive { false };
    // Held only: the order locks were granted in, for query().
    uint64_t grantOrder { 0 };
};

struct WebLockInfo {
    String name;
    String clientId;
    WebLockMode mode;
    bool ofAnotherClient;
    uint64_t order;
};

// One per context whose script made a request. Lives on that context's thread; the registry
// only knows its key, and reaches it with tasks posted to the context.
class WebLockClient final : public RefCounted<WebLockClient>, public ActiveDOMObject {
    WTF_MAKE_TZONE_ALLOCATED(WebLockClient);

public:
    static RefPtr<WebLockClient> ofContext(ScriptExecutionContext&);
    static Ref<WebLockClient> ensureForContext(ScriptExecutionContext&);
    ~WebLockClient() = default;

    // ActiveDOMObject.
    void ref() const final { RefCounted::ref(); }
    void deref() const final { RefCounted::deref(); }

    static void deliver(uint64_t key, uint64_t requestId, WebLockEvent);
    // The request ended on the JavaScript side: nothing more will be dispatched for it.
    static void forgetRecord(uint64_t requestId);

    uint64_t key() const { return m_key; }
    bool isStopped() const { return m_stopped; }
    void addRecord(VM& vm, uint64_t requestId, JSObject* record, JSObject* dispatcher)
    {
        m_records.add(requestId, JSC::Strong<JSObject>(vm, record));
        if (!m_dispatcher)
            m_dispatcher = JSC::Weak<JSObject>(dispatcher);
    }

private:
    explicit WebLockClient(ScriptExecutionContext&);

    // ActiveDOMObject.
    void stop() final;
    void contextDestroyed() final;

    const uint64_t m_key;
    // `dispatch` of internal/web_locks.ts, which its module keeps alive for as long as the global lives.
    JSC::Weak<JSObject> m_dispatcher;
    // What dispatch() is called with, rooted from request() until the request ends. Dropped
    // with the context, so the requests of a disposed Bun.ModuleGraph keep nothing of it alive.
    HashMap<uint64_t, JSC::Strong<JSObject>> m_records;
    unsigned m_eventLoopRefs { 0 };
    bool m_stopped { false };
};

// Every held lock and pending request of the process. Events are posted while m_lock is held, so
// each client receives them in the order the registry decided them (a lock is never reported
// broken before it is reported granted).
class WebLockRegistry {
    WTF_MAKE_NONCOPYABLE(WebLockRegistry);

public:
    static WebLockRegistry& singleton()
    {
        static NeverDestroyed<WebLockRegistry> registry;
        return registry.get();
    }

    void addClient(uint64_t key, String&& clientId)
    {
        Locker locker { m_lock };
        m_clientIds.add(key, WTF::move(clientId).isolatedCopy());
    }

    // Everything the client holds or waits for goes. Nothing is posted to it.
    void removeClient(uint64_t key)
    {
        Locker locker { m_lock };
        m_clientIds.remove(key);
        for (auto& slot : m_names) {
            auto& queue = slot.value;
            auto ofClient = [key](const WebLockRequest& request) { return request.clientKey == key; };
            // Deque::removeAllMatching() moves every element, and this is every queue of the process.
            if (!queue.held.containsIf(ofClient) && !queue.pending.containsIf(ofClient))
                continue;
            auto remove = [&](const WebLockRequest& request) {
                if (!ofClient(request))
                    return false;
                queue.removed(request);
                return true;
            };
            queue.held.removeAllMatching(remove);
            queue.pending.removeAllMatching(remove);
            process(queue);
        }
        m_names.removeIf([](auto& slot) { return slot.value.isEmpty(); });
    }

    // https://w3c.github.io/web-locks/#algorithm-request-lock
    uint64_t request(uint64_t clientKey, ScriptExecutionContext& context, const String& name, WebLockMode mode, bool ifAvailable, bool steal)
    {
        Locker locker { m_lock };
        WebLockRequest request { ++m_lastRequestId, clientKey, context.identifier(), context.currentLoopKind(), Thread::currentSingleton().uid(), mode };

        auto it = m_names.find(name);
        if (it == m_names.end())
            it = m_names.add(name.isolatedCopy(), NameQueue {}).iterator;
        auto& queue = it->value;

        if (steal) {
            for (auto& broken : queue.held) {
                post(broken, WebLockEvent::Broken);
                queue.removed(broken);
            }
            queue.held.clear();
            queue.pending.prepend(request);
        } else if (ifAvailable && !(queue.pending.isEmpty() && queue.isGrantable(mode))) {
            post(request, WebLockEvent::NotAvailable);
            return request.id;
        } else
            queue.pending.append(request);

        queue.added(request);
        process(queue);
        return request.id;
    }

    // False when the lock is not held anymore: it was stolen.
    bool release(const String& name, uint64_t id)
    {
        Locker locker { m_lock };
        auto it = m_names.find(name);
        if (it == m_names.end())
            return false;
        auto& queue = it->value;
        auto index = queue.held.findIf([id](const WebLockRequest& held) { return held.id == id; });
        if (index == notFound)
            return false;
        queue.removed(queue.held[index]);
        queue.held.removeAt(index);
        process(queue);
        if (queue.isEmpty())
            m_names.remove(it);
        return true;
    }

    // False when the request is no longer pending: it was granted first.
    bool abort(const String& name, uint64_t id)
    {
        Locker locker { m_lock };
        auto it = m_names.find(name);
        if (it == m_names.end())
            return false;
        auto& queue = it->value;
        auto pending = queue.pending.findIf([id](const WebLockRequest& pending) { return pending.id == id; });
        if (pending == queue.pending.end())
            return false;
        if (pending->keepsEventLoopAlive)
            post(*pending, WebLockEvent::UnrefEventLoop);
        queue.removed(*pending);
        queue.pending.remove(pending);
        process(queue);
        if (queue.isEmpty())
            m_names.remove(it);
        return true;
    }

    // https://w3c.github.io/web-locks/#snapshot-the-lock-state: the whole process, as a browser
    // reports the whole origin. Pending requests are in the order they were made. Held locks
    // are in the order they were granted, the asking client's own first: Node.js reports only
    // those, so code written for it reads `held[0]` as its own lock.
    void snapshot(uint64_t askingClientKey, Vector<WebLockInfo>& held, Vector<WebLockInfo>& pending)
    {
        {
            Locker locker { m_lock };
            for (auto& slot : m_names) {
                for (auto& request : slot.value.held)
                    held.append(WebLockInfo { slot.key.isolatedCopy(), m_clientIds.get(request.clientKey).isolatedCopy(), request.mode, request.clientKey != askingClientKey, request.grantOrder });
                for (auto& request : slot.value.pending)
                    pending.append(WebLockInfo { slot.key.isolatedCopy(), m_clientIds.get(request.clientKey).isolatedCopy(), request.mode, false, request.id });
            }
        }
        auto inOrder = [](const WebLockInfo& a, const WebLockInfo& b) {
            return a.ofAnotherClient != b.ofAnotherClient ? b.ofAnotherClient : a.order < b.order;
        };
        std::ranges::sort(held, inOrder);
        std::ranges::sort(pending, inOrder);
    }

private:
    friend class NeverDestroyed<WebLockRegistry>;
    WebLockRegistry() = default;

    struct NameQueue {
        Vector<WebLockRequest> held;
        Deque<WebLockRequest> pending;
        // How many of the requests above each thread has, and how many pending ones hold a keep-alive.
        Vector<std::pair<uint32_t, unsigned>, 2> threads;
        unsigned keepAlives { 0 };

        bool isEmpty() const { return held.isEmpty() && pending.isEmpty(); }
        // Held locks are either one exclusive lock or any number of shared ones.
        bool isGrantable(WebLockMode mode) const
        {
            return held.isEmpty() || (mode == WebLockMode::Shared && held.first().mode == WebLockMode::Shared);
        }

        void added(const WebLockRequest& request)
        {
            for (auto& [thread, count] : threads) {
                if (thread == request.threadUID) {
                    count++;
                    return;
                }
            }
            threads.append({ request.threadUID, 1 });
        }

        void removed(const WebLockRequest& request)
        {
            if (request.keepsEventLoopAlive)
                keepAlives--;
            threads.removeFirstMatching([&](auto& entry) { return entry.first == request.threadUID && !--entry.second; });
        }
    };

    // https://w3c.github.io/web-locks/#process-the-lock-request-queue, then the keep-alives: a
    // pending request keeps its thread alive exactly while a lock or request of another thread is
    // ahead of it. Only then can it be granted without script of its own thread running first.
    // Behind nothing but its own thread's locks it is an unsettled promise like any other.
    void process(NameQueue& queue) WTF_REQUIRES_LOCK(m_lock)
    {
        while (!queue.pending.isEmpty() && queue.isGrantable(queue.pending.first().mode)) {
            auto granted = queue.pending.takeFirst();
            bool keptEventLoopAlive = std::exchange(granted.keepsEventLoopAlive, false);
            granted.grantOrder = ++m_lastGrantOrder;
            post(granted, WebLockEvent::Granted);
            // After the grant: the first post wakes the thread, and with the keep-alive gone it
            // could find nothing to wait for and exit before the grant is in its queue.
            if (keptEventLoopAlive) {
                queue.keepAlives--;
                post(granted, WebLockEvent::UnrefEventLoop);
            }
            queue.held.append(granted);
        }

        // One thread's queue, however long, needs no pass over it.
        if (queue.threads.size() < 2 && !queue.keepAlives)
            return;

        bool anyAhead = false;
        bool severalThreadsAhead = false;
        uint32_t threadAhead = 0;
        auto ahead = [&](const WebLockRequest& request) {
            if (!anyAhead) {
                anyAhead = true;
                threadAhead = request.threadUID;
            } else if (request.threadUID != threadAhead)
                severalThreadsAhead = true;
        };
        for (auto& held : queue.held)
            ahead(held);
        for (auto& pending : queue.pending) {
            bool keepAlive = anyAhead && (severalThreadsAhead || threadAhead != pending.threadUID);
            if (keepAlive != pending.keepsEventLoopAlive) {
                pending.keepsEventLoopAlive = keepAlive;
                queue.keepAlives += keepAlive ? 1 : -1;
                post(pending, keepAlive ? WebLockEvent::RefEventLoop : WebLockEvent::UnrefEventLoop);
            }
            ahead(pending);
        }
    }

    void post(const WebLockRequest& request, WebLockEvent event) WTF_REQUIRES_LOCK(m_lock)
    {
        // Refused when the context is gone or going; stopping the client removes what it had.
        ScriptExecutionContext::postTaskTo(request.contextId, request.loopKind, [clientKey = request.clientKey, id = request.id, event](ScriptExecutionContext&) {
            WebLockClient::deliver(clientKey, id, event);
        });
    }

    Lock m_lock;
    HashMap<String, NameQueue> m_names WTF_GUARDED_BY_LOCK(m_lock);
    HashMap<uint64_t, String> m_clientIds WTF_GUARDED_BY_LOCK(m_lock);
    uint64_t m_lastRequestId WTF_GUARDED_BY_LOCK(m_lock) { 0 };
    uint64_t m_lastGrantOrder WTF_GUARDED_BY_LOCK(m_lock) { 0 };
};

WTF_MAKE_TZONE_ALLOCATED_IMPL(WebLockClient);

using WebLockClientsOfThread = HashMap<uint64_t, RefPtr<WebLockClient>>;
// Allocated with a thread's first client and freed with its last, so no destructor runs at thread exit.
static thread_local WebLockClientsOfThread* s_webLockClientsOfThread;

WebLockClient::WebLockClient(ScriptExecutionContext& context)
    : ActiveDOMObject(&context)
    , m_key([] {
        static std::atomic<uint64_t> lastKey { 0 };
        return ++lastKey;
    }())
{
}

RefPtr<WebLockClient> WebLockClient::ofContext(ScriptExecutionContext& context)
{
    if (s_webLockClientsOfThread) {
        for (auto& client : s_webLockClientsOfThread->values()) {
            if (client->scriptExecutionContext() == &context)
                return client;
        }
    }
    return nullptr;
}

Ref<WebLockClient> WebLockClient::ensureForContext(ScriptExecutionContext& context)
{
    if (RefPtr existing = ofContext(context))
        return existing.releaseNonNull();

    auto client = adoptRef(*new WebLockClient(context));
    if (!s_webLockClientsOfThread)
        s_webLockClientsOfThread = new WebLockClientsOfThread;
    s_webLockClientsOfThread->add(client->m_key, client.ptr());
    // What query() reports: the process and the context, which for a thread's own context is
    // the thread as node:worker_threads counts them.
    WebLockRegistry::singleton().addClient(client->m_key, makeString("bun-"_s, getCurrentProcessID(), '-', context.identifier() - 1));
    // Stops it right away when the context already has.
    client->suspendIfNeeded();
    return client;
}

void WebLockClient::stop()
{
    if (m_stopped)
        return;
    m_stopped = true;

    Ref protectedThis { *this };
    WebLockRegistry::singleton().removeClient(m_key);
    if (RefPtr context = scriptExecutionContext()) {
        for (; m_eventLoopRefs; --m_eventLoopRefs)
            context->unrefEventLoop();
    }
    m_records.clear();
    m_dispatcher.clear();
    if (s_webLockClientsOfThread) {
        s_webLockClientsOfThread->remove(m_key);
        if (s_webLockClientsOfThread->isEmpty()) {
            delete s_webLockClientsOfThread;
            s_webLockClientsOfThread = nullptr;
        }
    }
}

void WebLockClient::contextDestroyed()
{
    Ref protectedThis { *this };
    stop();
    ActiveDOMObject::contextDestroyed();
}

void WebLockClient::forgetRecord(uint64_t requestId)
{
    if (!s_webLockClientsOfThread)
        return;
    for (auto& client : s_webLockClientsOfThread->values()) {
        if (client->m_records.remove(requestId))
            return;
    }
}

void WebLockClient::deliver(uint64_t key, uint64_t requestId, WebLockEvent event)
{
    RefPtr client = s_webLockClientsOfThread ? s_webLockClientsOfThread->get(key) : nullptr;
    if (!client || client->m_stopped)
        return;
    RefPtr context = client->scriptExecutionContext();
    if (!context)
        return;

    switch (event) {
    case WebLockEvent::RefEventLoop:
        client->m_eventLoopRefs++;
        context->refEventLoop();
        return;
    case WebLockEvent::UnrefEventLoop:
        if (client->m_eventLoopRefs) {
            client->m_eventLoopRefs--;
            context->unrefEventLoop();
        }
        return;
    case WebLockEvent::Granted:
    case WebLockEvent::NotAvailable:
    case WebLockEvent::Broken:
        break;
    }

    // A held lock may still be reported broken. The other two are the last word on the request.
    JSC::Strong<JSObject> ended;
    JSObject* record = nullptr;
    if (event == WebLockEvent::Granted) {
        if (auto it = client->m_records.find(requestId); it != client->m_records.end())
            record = it->value.get();
    } else {
        ended = client->m_records.take(requestId);
        record = ended.get();
    }
    JSObject* dispatcher = client->m_dispatcher.get();
    if (!record || !dispatcher || context->isJSExecutionForbidden())
        return;
    auto callData = JSC::getCallData(dispatcher);
    if (callData.type == CallData::Type::None)
        return;

    auto* globalObject = dispatcher->globalObject();
    auto& vm = globalObject->vm();
    MarkedArgumentBuffer args;
    args.append(record);
    args.append(jsNumber(static_cast<int32_t>(event)));
    ASSERT(!args.hasOverflowed());

    // The dispatcher catches what the callback of request() throws. Anything else is a bug in
    // it, reported like the exception of any other event-loop callback.
    auto scope = DECLARE_TOP_EXCEPTION_SCOPE(vm);
    JSC::profiledCall(globalObject, ProfilingReason::API, dispatcher, callData, jsUndefined(), args);
    if (auto* exception = scope.exception(); exception && !vm.hasPendingTerminationException()) {
        scope.clearException();
        Zig::GlobalObject::reportUncaughtExceptionAtEventLoop(globalObject, exception);
    }
}

static uint64_t webLockRequestIdArgument(CallFrame* callFrame, unsigned index)
{
    JSValue value = callFrame->argument(index);
    return value.isNumber() && value.asNumber() > 0 ? static_cast<uint64_t>(value.asNumber()) : 0;
}

JSC_DEFINE_HOST_FUNCTION(jsWebLocksRequest, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSObject* record = callFrame->argument(0).getObject();
    JSObject* dispatcher = callFrame->argument(1).getObject();
    ASSERT(record && dispatcher);
    if (!record || !dispatcher)
        return JSValue::encode(jsNumber(0));
    String name = callFrame->argument(2).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    auto mode = callFrame->argument(3).toBoolean(globalObject) ? WebLockMode::Shared : WebLockMode::Exclusive;
    bool ifAvailable = callFrame->argument(4).toBoolean(globalObject);
    bool steal = callFrame->argument(5).toBoolean(globalObject);

    // The context of the running script: its Bun.ModuleGraph's when it is inside one.
    Ref context = *defaultGlobalObject(globalObject)->currentScriptExecutionContext();
    // What a disposed graph still starts stays pending (-1), like everything else it starts.
    if (context->isStopped())
        return JSValue::encode(jsNumber(context->isForModuleGraph() ? -1 : 0));
    Ref client = WebLockClient::ensureForContext(context);
    if (client->isStopped())
        return JSValue::encode(jsNumber(0));

    // Whatever the registry posts about the request is delivered by a later task of this thread.
    uint64_t id = WebLockRegistry::singleton().request(client->key(), context, name, mode, ifAvailable, steal);
    client->addRecord(vm, id, record, dispatcher);
    return JSValue::encode(jsNumber(static_cast<double>(id)));
}

JSC_DEFINE_HOST_FUNCTION(jsWebLocksRelease, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    String name = callFrame->argument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    uint64_t id = webLockRequestIdArgument(callFrame, 1);
    WebLockClient::forgetRecord(id);
    return JSValue::encode(jsBoolean(WebLockRegistry::singleton().release(name, id)));
}

JSC_DEFINE_HOST_FUNCTION(jsWebLocksAbort, (JSGlobalObject * globalObject, CallFrame* callFrame))
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    String name = callFrame->argument(0).toWTFString(globalObject);
    RETURN_IF_EXCEPTION(scope, {});
    uint64_t id = webLockRequestIdArgument(callFrame, 1);
    // When it was granted in the meantime, that is still to be dispatched.
    if (!WebLockRegistry::singleton().abort(name, id))
        return JSValue::encode(jsBoolean(false));
    WebLockClient::forgetRecord(id);
    return JSValue::encode(jsBoolean(true));
}

static JSArray* webLockInfosToJS(JSGlobalObject* globalObject, const Vector<WebLockInfo>& infos)
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    JSArray* array = constructEmptyArray(globalObject, nullptr, infos.size());
    RETURN_IF_EXCEPTION(scope, nullptr);
    unsigned index = 0;
    for (auto& info : infos) {
        JSObject* object = constructEmptyObject(globalObject, globalObject->objectPrototype(), 3);
        object->putDirect(vm, vm.propertyNames->name, jsString(vm, info.name));
        object->putDirect(vm, Identifier::fromString(vm, "mode"_s), jsNontrivialString(vm, info.mode == WebLockMode::Shared ? "shared"_s : "exclusive"_s));
        object->putDirect(vm, Identifier::fromString(vm, "clientId"_s), jsString(vm, info.clientId));
        array->putDirectIndex(globalObject, index++, object);
        RETURN_IF_EXCEPTION(scope, nullptr);
    }
    return array;
}

JSC_DEFINE_HOST_FUNCTION(jsWebLocksQuery, (JSGlobalObject * globalObject, CallFrame*))
{
    auto& vm = globalObject->vm();
    auto scope = DECLARE_THROW_SCOPE(vm);

    RefPtr client = WebLockClient::ofContext(*defaultGlobalObject(globalObject)->currentScriptExecutionContext());
    Vector<WebLockInfo> held;
    Vector<WebLockInfo> pending;
    WebLockRegistry::singleton().snapshot(client ? client->key() : 0, held, pending);

    JSArray* heldArray = webLockInfosToJS(globalObject, held);
    RETURN_IF_EXCEPTION(scope, {});
    JSArray* pendingArray = webLockInfosToJS(globalObject, pending);
    RETURN_IF_EXCEPTION(scope, {});

    JSObject* result = constructEmptyObject(globalObject, globalObject->objectPrototype(), 2);
    result->putDirect(vm, Identifier::fromString(vm, "held"_s), heldArray);
    result->putDirect(vm, Identifier::fromString(vm, "pending"_s), pendingArray);
    return JSValue::encode(result);
}

} // namespace WebCore
