"use client"

import type React from "react"

import { Button } from "@unprice/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@unprice/ui/tooltip"
import { m, useInView } from "framer-motion"
import { BarChart, Code, DollarSign, TrendingUp } from "lucide-react"
import { useEffect, useRef, useState } from "react"

type SectionKey = "growth" | "data" | "billing" | "opensource"

interface SectionData {
  title: string
  icon: React.ReactNode
  description: string
  color: string
  position: {
    angle: number
  }
}

// Define sections with precise geometric positions
const sections: Record<SectionKey, SectionData> = {
  growth: {
    title: "Spend Safety",
    icon: <TrendingUp className="h-full w-full p-3" />,
    description:
      "Put a real-time budget around your most expensive action. Reject over-budget customer or workload spend in the request path, before the work runs.",
    color: "bg-background-background",
    position: {
      angle: 270, // Top (270 degrees from right horizontal)
    },
  },
  billing: {
    title: "Bring Your Own Payments",
    icon: <DollarSign className="h-full w-full p-3" />,
    description:
      "Unprice owns the runtime money path; your provider still captures payment. Stripe-first today, with a provider model designed to extend to Paddle, Lemon Squeezy, and others.",
    color: "bg-background-background",
    position: {
      angle: 30, // Bottom left (30 degrees from right horizontal)
    },
  },
  data: {
    title: "Runtime Decisions",
    icon: <BarChart className="h-full w-full p-3" />,
    description:
      "Pricing is a runtime decision. Check entitlement, check budget, and consume usage while the request is in flight — not at invoice time.",
    color: "bg-background-background",
    position: {
      angle: 150, // Bottom right (150 degrees from right horizontal)
    },
  },
  opensource: {
    title: "Transparent & Reciprocal",
    icon: <Code className="h-full w-full p-3" />,
    description:
      "Monetization is too critical for black boxes. We use a reciprocal open-source license to ensure transparency and innovation remain at the core of your revenue engine.",
    color: "bg-background-background",
    position: {
      angle: 0, // Center (not used for positioning)
    },
  },
}

export function UnpriceManifesto() {
  const [activeSection, setActiveSection] = useState<SectionKey | null>(null)
  const [hoveredSection, setHoveredSection] = useState<SectionKey | null>(null)
  const [animationPhase, setAnimationPhase] = useState(0)
  const [showGoldenRatio, setShowGoldenRatio] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const isInView = useInView(containerRef, { once: true, amount: 0.3 })

  // Add click outside handler
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement
      // Check if click is outside of any tooltip trigger or content
      if (
        !target.closest("[data-radix-tooltip-trigger]") &&
        !target.closest("[data-radix-tooltip-content]")
      ) {
        setActiveSection(null)
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  // Control animation phases
  useEffect(() => {
    if (isInView) {
      const timer1 = setTimeout(() => setAnimationPhase(1), 200)
      const timer2 = setTimeout(() => setAnimationPhase(2), 400)
      const timer3 = setTimeout(() => setAnimationPhase(3), 600)

      return () => {
        clearTimeout(timer1)
        clearTimeout(timer2)
        clearTimeout(timer3)
      }
    }
  }, [isInView])

  // Geometry constants
  const circleRadius = 50
  const circleBorder = 8 // matches Tailwind border-[8px]
  const triangleStroke = 8 // visually matches the circle
  const triangleRadius = circleRadius - circleBorder / 2 - triangleStroke / 2

  // Angles for equilateral triangle (top, bottom left, bottom right)
  const triangleAngles = [270, 30, 150]

  function getPosition(angle: number, radius: number) {
    const angleInRadians = (angle * Math.PI) / 180
    const x = 50 + Math.cos(angleInRadians) * radius
    const y = 50 + Math.sin(angleInRadians) * radius
    return { x, y }
  }

  // Calculate centroid of the triangle for perfect center alignment
  function getTriangleCentroid() {
    const points = triangleAngles.map((angle) => getPosition(angle, triangleRadius))
    const centroidX = (points[0]!.x + points[1]!.x + points[2]!.x) / 3
    const centroidY = (points[0]!.y + points[1]!.y + points[2]!.y) / 3
    return { x: centroidX, y: centroidY }
  }

  const triangleCentroid = getTriangleCentroid()

  // Center point
  const centerPoint = { x: 50, y: 50 }

  const trianglePath = (() => {
    const points = triangleAngles.map((angle) => getPosition(angle, triangleRadius))
    return `M ${points[0]!.x},${points[0]!.y} L ${points[1]!.x},${points[1]!.y} L ${points[2]!.x},${points[2]!.y} Z`
  })()

  useEffect(() => {
    function handleScroll() {
      if (window.scrollY > 500) {
        setShowGoldenRatio(true)
      } else {
        setShowGoldenRatio(false)
      }
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <TooltipProvider>
      <div ref={containerRef} className="relative mx-auto w-full max-w-6xl px-6 py-32">
        <div className="relative mx-auto aspect-square w-full max-w-2xl">
          {/* Main circle */}
          <m.div
            className="absolute inset-0 rounded-full border-[5px] border-background-border"
            initial={{ scale: 0 }}
            animate={{ scale: isInView ? 1 : 0 }}
            transition={{
              duration: 0.3,
              delay: 0.1,
              type: "spring",
              stiffness: 100,
            }}
          />

          {/* Vitruvian Man-inspired guidelines (only visible when toggled) */}
          {showGoldenRatio && (
            <m.svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.2 }}
              transition={{ duration: 0.2 }}
            >
              {/* Golden ratio spiral */}
              <path
                d="M 50 50 Q 65 35, 80 50 T 50 80 T 20 50 T 50 20"
                fill="none"
                className="stroke-background-line dark:stroke-background-borderHover"
                strokeWidth="0.5"
                strokeDasharray="1,2"
              />

              {/* Golden ratio rectangles */}
              <rect
                x="30.9"
                y="30.9"
                width="38.2"
                height="38.2"
                className="stroke-background-border dark:stroke-background-bgHover"
                strokeWidth="0.3"
                fill="none"
              />
              <rect
                x="38.2"
                y="38.2"
                width="23.6"
                height="23.6"
                className="stroke-background-border dark:stroke-background-bgHover"
                strokeWidth="0.3"
                fill="none"
              />

              {/* Horizontal and vertical guidelines */}
              <line
                x1="0"
                y1="50"
                x2="100"
                y2="50"
                className="stroke-background-border dark:stroke-background-borderHover"
                strokeWidth="0.3"
                strokeDasharray="1,2"
              />
              <line
                x1="50"
                y1="0"
                x2="50"
                y2="100"
                className="stroke-background-border dark:stroke-background-borderHover"
                strokeWidth="0.3"
                strokeDasharray="1,2"
              />

              {/* Golden ratio circles */}
              <circle
                cx="50"
                cy="50"
                r="30.9"
                className="stroke-background-border dark:stroke-background-bgHover"
                strokeWidth="0.3"
                fill="none"
              />
              <circle
                cx="50"
                cy="50"
                r="19.1"
                className="stroke-background-border dark:stroke-background-bgHover"
                strokeWidth="0.3"
                fill="none"
              />
            </m.svg>
          )}

          {/* Center text */}
          <m.div
            className="absolute z-10 text-center"
            style={{
              left: `${triangleCentroid.x}%`,
              top: `${triangleCentroid.y}%`,
              transform: "translate(-50%, -50%)",
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: animationPhase >= 1 ? 1 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <m.div
              initial={{ scale: 0 }}
              animate={{ scale: animationPhase >= 1 ? 1 : 0 }}
              transition={{ duration: 0.3, delay: 0.1 }}
              className="-mb-5 font-bold text-2xl text-background-textContrast md:text-3xl"
            >
              UNPRICE
            </m.div>
            <m.div
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: animationPhase >= 1 ? 1 : 0, y: 15 }}
              transition={{ duration: 0.3, delay: 0.1 }}
              className="text-background-text text-sm"
            >
              the PriceOps Infrastructure
            </m.div>
          </m.div>

          {/* Triangle with perfect geometric alignment */}
          {animationPhase >= 2 && (
            <m.svg
              className="absolute inset-0 h-ful w-full"
              viewBox="0 0 100 100"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
              {/* Triangle path */}
              <m.path
                d={trianglePath}
                className="stroke-background-line"
                strokeWidth="0.7"
                fill="none"
                strokeLinejoin="round"
              />

              {/* Connecting lines from center to vertices (subtle) */}
              {Object.entries(sections).map(([key, section], index) => {
                // Skip the center section
                if (key === "opensource") return null

                const iconCenter = getPosition(section.position.angle, circleRadius)
                const iconX = iconCenter.x
                const iconY = iconCenter.y

                return (
                  <m.line
                    key={key}
                    x1={centerPoint.x}
                    y1={centerPoint.y}
                    x2={iconX}
                    y2={iconY}
                    className="stroke-background-line"
                    strokeWidth="0.2"
                    strokeDasharray="1,1"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: showGoldenRatio ? 1 : 0 }}
                    transition={{ duration: 0.2, delay: 0.1 * index }}
                  />
                )
              })}
            </m.svg>
          )}

          {/* Section icons */}
          {Object.entries(sections).map(([key, section], index) => {
            const sectionKey = key as SectionKey
            const isActive = activeSection === sectionKey
            const isHovered = hoveredSection === sectionKey

            // Skip the center "opensource" section for the vertices
            if (sectionKey === "opensource") {
              return null
            }

            // Icon/label position: center exactly on the circle's edge, icon outside
            const iconCenter = getPosition(section.position.angle, circleRadius)
            const iconX = iconCenter.x
            const iconY = iconCenter.y

            return (
              <div key={key} className="absolute h-full w-full">
                {/* Icon with circle background and tooltip */}
                <Tooltip open={isActive || isHovered}>
                  <TooltipTrigger asChild>
                    <Button
                      style={{
                        position: "absolute",
                        left: `${iconX}%`,
                        top: `${iconY}%`,
                        width: "3rem",
                        height: "3rem",
                        transform: "translate(-50%, -50%)",
                        zIndex: 10,
                        opacity: animationPhase >= 3 ? 1 : 0,
                        scale: animationPhase >= 3 ? 1 : 0.7,
                      }}
                      className={
                        "flex size-6 items-center justify-center rounded-full border p-0 shadow-sm transition-all"
                      }
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveSection(sectionKey === activeSection ? null : sectionKey)
                      }}
                      onMouseEnter={() => setHoveredSection(sectionKey)}
                      onMouseLeave={() => {
                        setHoveredSection(null)
                        // Only clear active section if we're not clicking the tooltip content
                        if (!document.querySelector("[data-radix-tooltip-content]:hover")) {
                          setActiveSection(null)
                        }
                      }}
                      variant="primary"
                    >
                      {section.icon}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    align="center"
                    className="w-64 bg-background-bg p-4"
                    onPointerEnter={() => setHoveredSection(sectionKey)}
                    onPointerLeave={() => {
                      setHoveredSection(null)
                      if (!isActive) {
                        setActiveSection(null)
                      }
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <div>
                        <h4 className="font-bold text-background-textContrast">{section.title}</h4>
                        <p className="mt-1 text-background-text text-sm">{section.description}</p>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
                {/* Section title */}
                <m.div
                  className="-translate-x-1/2 pointer-events-auto absolute hidden w-20 max-w-[150px] transform cursor-pointer text-left md:block"
                  style={{
                    left:
                      section.position.angle === 270
                        ? `${iconX + 5}%`
                        : section.position.angle === 30
                          ? `${iconX + 5}%`
                          : `${iconX - 18}%`,
                    top:
                      section.position.angle === 270
                        ? `${iconY - 10}%`
                        : section.position.angle === 30
                          ? `${iconY}%`
                          : `${iconY}%`,
                  }}
                  initial={{ opacity: 0, y: section.position.angle === 270 ? 10 : -10 }}
                  animate={{
                    opacity: animationPhase >= 3 ? 1 : 0,
                    y: 0,
                  }}
                  transition={{
                    duration: 0.2,
                    delay: 0.05 * index,
                  }}
                  onClick={() => setActiveSection(sectionKey === activeSection ? null : sectionKey)}
                  onMouseEnter={() => setHoveredSection(sectionKey)}
                  onMouseLeave={() => setHoveredSection(null)}
                >
                  <h3
                    className={`font-bold text-base md:text-lg ${isActive || isHovered ? "text-background-textContrast" : "text-background-text"}`}
                  >
                    {section.title}
                  </h3>
                </m.div>
              </div>
            )
          })}

          {/* Center "Open Source" section */}
          <m.div
            className="pointer-events-auto flex cursor-pointer items-center gap-1"
            style={{
              position: "absolute",
              left: `${centerPoint.x - 10}%`,
              top: `${centerPoint.y + 30}%`,
              width: 170,
              height: 50,
              transform: "translate(-50%, -50%)",
              zIndex: 10,
              opacity: animationPhase >= 3 ? 1 : 0,
              scale: animationPhase >= 3 ? 1 : 0.7,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: animationPhase >= 3 ? 1 : 0 }}
            transition={{ duration: 0.3, delay: 0.2 }}
          >
            <Tooltip open={activeSection === "opensource" || hoveredSection === "opensource"}>
              <TooltipTrigger asChild>
                <div
                  className={`flex w-full items-center gap-1 ${
                    activeSection === "opensource" || hoveredSection === "opensource"
                      ? "text-background-textContrast"
                      : "text-background-text"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveSection("opensource" === activeSection ? null : "opensource")
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.stopPropagation()
                      setActiveSection("opensource" === activeSection ? null : "opensource")
                    }
                  }}
                  onMouseEnter={() => setHoveredSection("opensource")}
                  onMouseLeave={() => {
                    setHoveredSection(null)
                    if (!document.querySelector("[data-radix-tooltip-content]:hover")) {
                      setActiveSection(null)
                    }
                  }}
                >
                  <Code className="h-5 w-5" />
                  <span className="font-medium text-sm md:text-lg">
                    {sections.opensource.title}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="top"
                align="center"
                className="w-64 bg-background-bg p-4"
                onPointerEnter={() => setHoveredSection("opensource")}
                onPointerLeave={() => {
                  setHoveredSection(null)
                  if (activeSection !== "opensource") {
                    setActiveSection(null)
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <div>
                    <h4 className="font-bold text-background-textContrast">
                      {sections.opensource.title}
                    </h4>
                    <p className="mt-1 text-background-text text-sm">
                      {sections.opensource.description}
                    </p>
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </m.div>
        </div>

        {/* Instructions */}
        <m.div
          className="mt-6 text-center text-background-text"
          initial={{ opacity: 0 }}
          animate={{ opacity: animationPhase >= 3 ? 1 : 0 }}
          transition={{ duration: 0.2, delay: 0.2 }}
        >
          <p className="text-sm">PriceOps infrastructure principles</p>
        </m.div>
      </div>
    </TooltipProvider>
  )
}
