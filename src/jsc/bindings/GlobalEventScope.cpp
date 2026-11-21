#include "config.h"

#include "GlobalEventScope.h"
#include "MessagePort.h"
#include "ScriptExecutionContext.h"
#include "ZigGlobalObject.h"
#include <wtf/TZoneMallocInlines.h>

namespace WebCore {

WTF_MAKE_TZONE_ALLOCATED_IMPL(GlobalEventScope);

extern "C" void Bun__VM__noteRejectionEventListener();

void GlobalEventScope::onDidChangeListenerImpl(EventTarget& self, const AtomString& eventType, OnDidChangeListenerKind kind)
{
    auto& names = eventNames();
    if (eventType == names.messageEvent) {
        auto& global = static_cast<GlobalEventScope&>(self);
        switch (kind) {
        case Add:
            global.m_messageEventCount++;
            break;
        case Remove:
            global.m_messageEventCount--;
            break;
        case Clear:
            global.m_messageEventCount = 0;
            break;
        }
        global.m_keepAlive.setActive(global.m_messageEventCount > 0);
    } else if (kind == Add && (eventType == names.unhandledrejectionEvent || eventType == names.rejectionhandledEvent)) {
        // From here on the thread asks the listeners about its rejections. Until then a rejection costs it nothing.
        Bun__VM__noteRejectionEventListener();
    }
};

}
