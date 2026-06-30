"use client"
import { Kbd } from "@unprice/ui/kbd"
import { TabNavigation, TabNavigationLink } from "@unprice/ui/tabs-navigation"
import { useRouter, useSearchParams } from "next/navigation"
import { useHotkeys } from "react-hotkeys-hook"
import { SuperLink } from "~/components/super-link"
import { useFlags } from "~/hooks/use-flags"
import { useMounted } from "~/hooks/use-mounted"

export const tabs = ["overview", "plans", "pages"] as const

const TabsDashboard = ({
  baseUrl,
  activeTab,
}: { baseUrl: string; activeTab: (typeof tabs)[number] }) => {
  const isMounted = useMounted()

  const isPagesEnabled = useFlags("PAGES")
  const showPages = isMounted && isPagesEnabled

  // add a query params in the url to avoid wipe the filters
  const params = useSearchParams()
  const allParams = params.toString()
  const router = useRouter()

  const visibleTabs = showPages ? ["overview", "plans", "pages"] : ["overview"]

  const tabKeys = showPages ? ["1", "2", "3"] : ["1"]

  // handle hotkeys
  useHotkeys(
    tabKeys,
    (_, handler) => {
      const key = handler.keys?.at(0) as string
      if (!key) return

      const tab = visibleTabs[Number(key) - 1]

      if (tab) {
        if (tab === activeTab) return
        if (tab === "overview") {
          router.push(`${baseUrl}/dashboard${allParams ? `?${allParams}` : ""}`, {
            scroll: false,
          })
          return
        }

        router.push(`${baseUrl}/dashboard/${tab}${allParams ? `?${allParams}` : ""}`, {
          scroll: false,
        })
      }
    },
    {
      keydown: false,
      keyup: true, // to avoid someone holding the key down and triggering the hotkey multiple times
    }
  )

  if (visibleTabs.length === 1) {
    return null
  }

  return (
    <TabNavigation className="gap-1" variant="solid">
      <TabNavigationLink active={activeTab === "overview"} asChild>
        <SuperLink href={`${baseUrl}/dashboard${allParams ? `?${allParams}` : ""}`}>
          Overview{" "}
          <Kbd abbrTitle="1" className="ml-2">
            1
          </Kbd>
        </SuperLink>
      </TabNavigationLink>
      {showPages && (
        <TabNavigationLink active={activeTab === "plans"} asChild>
          <SuperLink href={`${baseUrl}/dashboard/plans${allParams ? `?${allParams}` : ""}`}>
            Plans{" "}
            <Kbd abbrTitle="2" className="ml-2">
              2
            </Kbd>
          </SuperLink>
        </TabNavigationLink>
      )}
      {showPages && (
        <TabNavigationLink active={activeTab === "pages"} asChild>
          <SuperLink href={`${baseUrl}/dashboard/pages${allParams ? `?${allParams}` : ""}`}>
            Pages{" "}
            <Kbd abbrTitle="3" className="ml-2">
              3
            </Kbd>
          </SuperLink>
        </TabNavigationLink>
      )}
    </TabNavigation>
  )
}

export default TabsDashboard
