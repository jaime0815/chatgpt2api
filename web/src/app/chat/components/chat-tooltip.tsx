"use client"

import type { ReactElement, ReactNode } from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

export type ChatTooltipProps = {
  label: ReactNode
  children: ReactElement
  side?: "top" | "right" | "bottom" | "left"
}

export function ChatTooltip({ label, children, side = "top" }: ChatTooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={100}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className="z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-sm"
          >
            {label}
            <TooltipPrimitive.Arrow className="fill-foreground" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
