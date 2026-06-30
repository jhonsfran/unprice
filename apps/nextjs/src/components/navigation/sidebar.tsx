import { Fragment } from "react"
import { entitlementFlag } from "~/lib/flags"
import type { DashboardRoute, Shortcut } from "~/types"
import { Logo } from "../layout/logo"
import { ShortLink, Tab } from "../layout/tab"
import MobileSidebar from "./mobile-sidebar"
import { UserProfileDesktop, UserProfileMobile } from "./user-nav"

export async function Sidebar({
  shortcuts,
  routes,
  baseUrl,
  isMain,
}: {
  shortcuts: Shortcut[]
  routes: DashboardRoute[]
  baseUrl: string
  isMain: boolean
}) {
  // evaluate flags
  const activeRoutes = await Promise.all(
    routes.map(async (route) => {
      if (!route.featureSlug || isMain) {
        if (route.sidebar && route.sidebar.length > 0) {
          // check if the sidebar is active
          const sidebar = await Promise.all(
            route.sidebar.map(async (subItem) => {
              if (!subItem.featureSlug) {
                return subItem
              }

              const isActive = await entitlementFlag(subItem.featureSlug)
              return isActive ? subItem : null
            })
          )

          return {
            ...route,
            sidebar: sidebar.filter((subItem) => subItem !== null),
          }
        }

        // if no sidebar, return the route
        return route
      }

      const isActive = await entitlementFlag(route.featureSlug)

      return isActive ? route : null // Return the route if active, otherwise null
    })
  )

  const activeShortcuts = await Promise.all(
    shortcuts.map(async (shortcut) => {
      if (!shortcut.featureSlug || isMain) {
        return shortcut
      }

      const isActive = await entitlementFlag(shortcut.featureSlug)
      return isActive ? shortcut : null
    })
  )

  // Filter out null values
  const filteredActiveRoutes = activeRoutes.filter((route) => route !== null)
  const filteredShortcuts = activeShortcuts.filter((shortcut) => shortcut !== null)

  return (
    <Fragment>
      {/* sidebar (lg+) */}
      <nav className="top-0 z-40 hidden h-screen gap-2 lg:inset-y-0 lg:z-50 lg:flex lg:w-56 lg:flex-col">
        <aside className="flex grow flex-col gap-y-6 overflow-y-auto border-r p-4">
          <Logo />
          <nav aria-label="core navigation links" className="flex flex-1 flex-col space-y-10">
            <ul className="space-y-1">
              {filteredActiveRoutes.map((item) => (
                <li key={item.name}>
                  <Tab
                    href={item.href}
                    baseUrl={baseUrl}
                    disabled={item.disabled}
                    isNew={item.isNew}
                    hasSubmenu={!!item.sidebar}
                  >
                    <item.icon className="size-4 shrink-0" aria-hidden="true" />
                    {item.name}
                  </Tab>

                  {item?.sidebar && (
                    <ul className="space-y-0.5 py-1 pl-7">
                      {item.sidebar.map((subItem) => (
                        <li key={subItem.name}>
                          <Tab href={subItem.href} baseUrl={baseUrl}>
                            {subItem.icon && (
                              <subItem.icon className="size-3 shrink-0" aria-hidden="true" />
                            )}
                            {subItem.name}
                          </Tab>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            <div>
              <span className="font-medium text-background-solid text-xs leading-6">Shortcuts</span>
              <ul aria-label="shortcuts" className="space-y-0.5">
                {filteredShortcuts.map((item) => (
                  <li key={`${baseUrl}/${item.href}`}>
                    <ShortLink href={`${baseUrl}/${item.href}`}>
                      <item.icon className="size-3 shrink-0" aria-hidden="true" />
                      {item.name}
                    </ShortLink>
                  </li>
                ))}
              </ul>
            </div>
          </nav>
          <div className="mt-auto">
            <UserProfileDesktop />
          </div>
        </aside>
      </nav>
      {/* top navbar (xs-lg) */}
      <div className="sticky top-0 z-40 flex h-16 w-full shrink-0 items-center justify-between border-b px-2 shadow-sm sm:gap-x-6 sm:px-4 lg:hidden">
        <Logo />
        <div className="flex items-center gap-1 sm:gap-2">
          <UserProfileMobile />
          <MobileSidebar>
            <nav
              aria-label="core mobile navigation links"
              className="flex flex-1 flex-col space-y-10"
            >
              <ul className="space-y-1.5">
                {filteredActiveRoutes.map((item) => (
                  <li key={item.name}>
                    <Tab
                      href={item.href}
                      baseUrl={baseUrl}
                      disabled={item.disabled}
                      isNew={item.isNew}
                      hasSubmenu={!!item.sidebar}
                    >
                      <item.icon className="size-4 shrink-0" aria-hidden="true" />
                      {item.name}
                    </Tab>

                    {item?.sidebar && (
                      <ul className="space-y-0.5 pl-7">
                        {item.sidebar.map((subItem) => (
                          <li key={subItem.name}>
                            <Tab href={subItem.href} baseUrl={baseUrl}>
                              {subItem.icon && (
                                <subItem.icon className="size-3 shrink-0" aria-hidden="true" />
                              )}
                              {subItem.name}
                            </Tab>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              <div>
                <span className="font-medium text-gray-500 text-sm leading-6 sm:text-xs">
                  Shortcuts
                </span>
                <ul aria-label="shortcuts" className="space-y-0.5">
                  {filteredShortcuts.map((item) => (
                    <li key={`${baseUrl}/${item.href}`}>
                      <ShortLink href={`${baseUrl}/${item.href}`}>
                        <item.icon className="size-3 shrink-0" aria-hidden="true" />
                        {item.name}
                      </ShortLink>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          </MobileSidebar>
        </div>
      </div>
    </Fragment>
  )
}
