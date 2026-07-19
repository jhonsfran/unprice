"use client"

import { type RefCallback, type RefObject, useEffect, useMemo, useRef, useState } from "react"

export type MoneyPathWaypointId =
  | "request"
  | "meter"
  | "access"
  | "pricing-rule"
  | "price"
  | "decision"
  | "allow-chip"
  | "deny-chip"
  | "wallet"
  | "ledger"
  | "invoice"
  | "payment"

export type MoneyPathStation = {
  id?: MoneyPathWaypointId
  label: string
  fact: string
}

export type MoneyPathBudget = { value: number; short: boolean }

export type MoneyPathChoreography = {
  budget: MoneyPathBudget
  passNumber: number | null
}

export type MoneyPathPassPlan = {
  kind: "deny" | "allow"
  budgetStart: number
  budgetAfterReserve?: number
}

const WAYPOINT_IDS: MoneyPathWaypointId[] = [
  "request",
  "meter",
  "access",
  "pricing-rule",
  "price",
  "decision",
  "allow-chip",
  "deny-chip",
  "wallet",
  "ledger",
  "invoice",
  "payment",
]

const SETTLE_WAYPOINT_IDS: MoneyPathWaypointId[] = ["wallet", "ledger", "invoice"]
const REQUEST_COST = 4.1
const BUDGET_START = 10

export const MONEY_PATH_PASS_PLAN: MoneyPathPassPlan[] = [
  { kind: "allow", budgetStart: BUDGET_START, budgetAfterReserve: BUDGET_START - REQUEST_COST },
  {
    kind: "allow",
    budgetStart: BUDGET_START - REQUEST_COST,
    budgetAfterReserve: BUDGET_START - 2 * REQUEST_COST,
  },
  { kind: "deny", budgetStart: BUDGET_START - 2 * REQUEST_COST },
]

const DOT_SIZE = 9
const TRAVEL_SPEED = 0.34
const FADE_MS = 200
const STATION_DWELL = 300
const DECISION_DWELL = 650
const HIT_LINGER = 700
const OUTCOME_LINGER = 1600
const PASS_GAP = 1100
const CYCLE_GAP = 1800
const RAIL_OFFSET_X = 8
const CHIP_CLEARANCE_Y = 6
const PERSIST = Number.POSITIVE_INFINITY

type BuiltPass = {
  keyframes: Keyframe[]
  duration: number
  hits: { el: HTMLElement; at: number; until: number }[]
  sets: { at: number; value: number }[]
}

type WaypointElements = Record<MoneyPathWaypointId, HTMLElement | null>

export type MoneyPathElementSnapshot = {
  root: HTMLElement
  connector: HTMLElement | null
  waypoints: WaypointElements
  railDots: WaypointElements
}

export type MoneyPathRegistry = {
  stageRef: RefObject<HTMLDivElement>
  connectorRef: RefObject<HTMLDivElement>
  dotRef: RefObject<HTMLSpanElement>
  waypointRefs: Record<MoneyPathWaypointId, RefCallback<HTMLElement>>
  railDotRefs: Record<MoneyPathWaypointId, RefCallback<HTMLElement>>
  waypointElements: { current: WaypointElements }
  railDotElements: { current: WaypointElements }
}

function emptyWaypointElements(): WaypointElements {
  return Object.fromEntries(WAYPOINT_IDS.map((id) => [id, null])) as WaypointElements
}

function elementRefCallbacks(elements: { current: WaypointElements }): Record<
  MoneyPathWaypointId,
  RefCallback<HTMLElement>
> {
  const callbacks = {} as Record<MoneyPathWaypointId, RefCallback<HTMLElement>>
  for (const id of WAYPOINT_IDS) {
    callbacks[id] = (element) => {
      elements.current[id] = element
    }
  }
  return callbacks
}

export function useMoneyPathRegistry(): MoneyPathRegistry {
  const stageRef = useRef<HTMLDivElement>(null)
  const connectorRef = useRef<HTMLDivElement>(null)
  const dotRef = useRef<HTMLSpanElement>(null)
  const waypointElements = useRef<WaypointElements>(emptyWaypointElements())
  const railDotElements = useRef<WaypointElements>(emptyWaypointElements())
  const waypointRefs = useMemo(() => elementRefCallbacks(waypointElements), [])
  const railDotRefs = useMemo(() => elementRefCallbacks(railDotElements), [])

  return useMemo(
    () => ({
      stageRef,
      connectorRef,
      dotRef,
      waypointRefs,
      railDotRefs,
      waypointElements,
      railDotElements,
    }),
    [railDotRefs, waypointRefs]
  )
}

export function buildMoneyPathPass(
  elements: MoneyPathElementSnapshot,
  plan: MoneyPathPassPlan,
  stations: readonly MoneyPathStation[]
): BuiltPass | null {
  const rootBox = elements.root.getBoundingClientRect()
  if (rootBox.width === 0) return null

  const request = elements.waypoints.request
  const decision = elements.waypoints.decision
  if (!request || !decision) return null

  const railDotCenter = (id: MoneyPathWaypointId) => {
    const dot = elements.railDots[id]
    if (!dot) return null
    const box = dot.getBoundingClientRect()
    return {
      x: box.left - rootBox.left + box.width / 2,
      y: box.top - rootBox.top + box.height / 2,
      size: box.width,
    }
  }
  const railPointOf = (id: MoneyPathWaypointId, element: HTMLElement) => {
    const dot = railDotCenter(id)
    if (dot) return dot
    const box = element.getBoundingClientRect()
    return {
      x: box.left - rootBox.left + RAIL_OFFSET_X,
      y: box.top - rootBox.top + box.height / 2,
      size: DOT_SIZE,
    }
  }
  const railXOf = (id: MoneyPathWaypointId, element: HTMLElement) =>
    railDotCenter(id)?.x ?? element.getBoundingClientRect().left - rootBox.left + RAIL_OFFSET_X

  const requestPoint = railPointOf("request", request)
  const railX = requestPoint.x
  const points: { x: number; y: number; opacity: number; time: number; size: number }[] = []
  const hits: BuiltPass["hits"] = []
  const sets: BuiltPass["sets"] = []
  let time = 0

  const currentSize = () => points[points.length - 1]?.size ?? DOT_SIZE
  const jump = (x: number, y: number, opacity: number, ms: number, size = currentSize()) => {
    time += ms
    points.push({ x, y, opacity, time, size })
  }
  const move = (x: number, y: number, size = currentSize()) => {
    const previous = points[points.length - 1]
    if (previous) time += Math.hypot(x - previous.x, y - previous.y) / TRAVEL_SPEED
    points.push({ x, y, opacity: 1, time, size })
  }
  const dwell = (ms: number) => {
    const previous = points[points.length - 1]
    if (!previous) return
    time += ms
    points.push({ ...previous, time })
  }
  const hit = (element: HTMLElement | null, linger = HIT_LINGER) => {
    if (element) hits.push({ el: element, at: time, until: time + linger })
  }
  const fadeOut = () => {
    const previous = points[points.length - 1]
    if (previous) jump(previous.x, previous.y, 0, FADE_MS)
  }
  const setBudget = (value: number) => sets.push({ at: time, value })

  setBudget(plan.budgetStart)
  points.push({
    x: requestPoint.x,
    y: requestPoint.y,
    opacity: 0,
    time: 0,
    size: requestPoint.size,
  })
  jump(requestPoint.x, requestPoint.y, 1, FADE_MS, requestPoint.size)
  hit(request)
  dwell(STATION_DWELL)

  for (const station of stations) {
    if (!station.id) continue
    const element = elements.waypoints[station.id]
    if (!element) continue
    const point = railPointOf(station.id, element)
    move(point.x, point.y, point.size)
    hit(element)
    dwell(STATION_DWELL)
  }

  const decisionPoint = railPointOf("decision", decision)
  move(decisionPoint.x, decisionPoint.y, decisionPoint.size)
  hit(decision)
  dwell(DECISION_DWELL)

  if (plan.kind === "deny") {
    const denyChip = elements.waypoints["deny-chip"]
    if (!denyChip) return null
    const denyX = railXOf("deny-chip", denyChip)
    const denyTop = denyChip.getBoundingClientRect().top - rootBox.top
    const hasBranch = elements.connector && getComputedStyle(elements.connector).display !== "none"

    if (hasBranch && elements.connector) {
      const branchY = elements.connector.getBoundingClientRect().top - rootBox.top + 12
      move(railX, branchY)
      move(denyX, branchY)
      move(denyX, denyTop - CHIP_CLEARANCE_Y)
    } else {
      move(railX, denyTop - CHIP_CLEARANCE_Y)
    }
    fadeOut()
    hit(denyChip, PERSIST)
    dwell(320)
  } else {
    const allowChip = elements.waypoints["allow-chip"]
    if (!allowChip) return null
    const chipTop = allowChip.getBoundingClientRect().top - rootBox.top
    move(railX, chipTop - CHIP_CLEARANCE_Y)
    fadeOut()
    hit(allowChip, PERSIST)
    if (plan.budgetAfterReserve !== undefined && !elements.waypoints.wallet) {
      setBudget(plan.budgetAfterReserve)
    }
    dwell(STATION_DWELL)

    for (const [index, id] of SETTLE_WAYPOINT_IDS.entries()) {
      const element = elements.waypoints[id]
      if (!element) continue
      const point = railPointOf(id, element)
      if (index === 0) {
        jump(point.x, point.y, 0, 40, point.size)
        jump(point.x, point.y, 1, FADE_MS, point.size)
      } else {
        move(point.x, point.y, point.size)
      }
      hit(element)
      if (id === "wallet" && plan.budgetAfterReserve !== undefined) {
        setBudget(plan.budgetAfterReserve)
      }
      dwell(STATION_DWELL)
    }

    const payment = elements.waypoints.payment
    if (payment) {
      const point = railPointOf("payment", payment)
      move(point.x, point.y, point.size)
      hit(payment, OUTCOME_LINGER)
      dwell(320)
    }
    fadeOut()
  }

  if (time <= 0) return null
  const keyframes = points.map((point) => ({
    transform: `translate3d(${(point.x - point.size / 2).toFixed(1)}px, ${(point.y - point.size / 2).toFixed(1)}px, 0)`,
    width: `${point.size}px`,
    height: `${point.size}px`,
    opacity: point.opacity,
    offset: Math.min(1, point.time / time),
  }))

  return { keyframes, duration: time, hits, sets }
}

export function useMoneyPathChoreography(
  registry: MoneyPathRegistry,
  stations: readonly MoneyPathStation[]
): MoneyPathChoreography {
  const [budget, setBudget] = useState<MoneyPathBudget>({ value: BUDGET_START, short: false })
  const [passNumber, setPassNumber] = useState<number | null>(null)

  useEffect(() => {
    const root = registry.stageRef.current
    const dot = registry.dotRef.current
    if (!root || !dot) return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    let cancelled = false
    let animationFrame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let animation: Animation | null = null
    let hits: BuiltPass["hits"] = []
    let sets: BuiltPass["sets"] = []
    let setIndex = 0
    let passIndex = 0

    const clearHits = () => {
      for (const hit of hits) hit.el.removeAttribute("data-mp-hit")
    }

    const tick = () => {
      if (animation) {
        const now = Number(animation.currentTime ?? 0)
        for (const hit of hits) {
          if (now >= hit.at && now <= hit.until) hit.el.setAttribute("data-mp-hit", "true")
          else if (hit.el.hasAttribute("data-mp-hit")) hit.el.removeAttribute("data-mp-hit")
        }
        while (setIndex < sets.length && now >= (sets[setIndex]?.at ?? Number.POSITIVE_INFINITY)) {
          const nextBudget = sets[setIndex]
          if (nextBudget) {
            setBudget({ value: nextBudget.value, short: nextBudget.value < REQUEST_COST })
          }
          setIndex += 1
        }
      }
      animationFrame = requestAnimationFrame(tick)
    }

    const runPass = () => {
      if (cancelled) return
      animation?.cancel()
      clearHits()
      const plan = MONEY_PATH_PASS_PLAN[passIndex % MONEY_PATH_PASS_PLAN.length]
      if (!plan) return
      root.setAttribute("data-mp-outcome", plan.kind)
      setPassNumber((passIndex % MONEY_PATH_PASS_PLAN.length) + 1)
      passIndex += 1
      const built = buildMoneyPathPass(
        {
          root,
          connector: registry.connectorRef.current,
          waypoints: registry.waypointElements.current,
          railDots: registry.railDotElements.current,
        },
        plan,
        stations
      )
      if (!built) return
      hits = built.hits
      sets = built.sets
      setIndex = 0
      animation = dot.animate(built.keyframes, {
        duration: built.duration,
        easing: "linear",
        fill: "forwards",
      })
      animation.finished
        .then(() => {
          if (cancelled) return
          const gap = passIndex % MONEY_PATH_PASS_PLAN.length === 0 ? CYCLE_GAP : PASS_GAP
          timer = setTimeout(runPass, gap)
        })
        .catch(() => {})
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return
        observer.disconnect()
        runPass()
        animationFrame = requestAnimationFrame(tick)
      },
      { threshold: 0.2 }
    )
    observer.observe(root)

    return () => {
      cancelled = true
      observer.disconnect()
      cancelAnimationFrame(animationFrame)
      if (timer) clearTimeout(timer)
      animation?.cancel()
      clearHits()
      root.removeAttribute("data-mp-outcome")
      setBudget({ value: BUDGET_START, short: false })
      setPassNumber(null)
    }
  }, [registry, stations])

  return { budget, passNumber }
}
