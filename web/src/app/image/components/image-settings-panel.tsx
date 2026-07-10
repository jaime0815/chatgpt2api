"use client"

import { Info } from "lucide-react"
import type { ReactElement } from "react"

import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { withBasePath } from "@/lib/paths"
import { cn } from "@/lib/utils"

import {
  aspectOptions,
  countOptions,
  isImagePresetDisabled,
  qualityOptions,
  type ImageSettings,
} from "./image-settings"

export type ImageSettingsPanelProps = {
  presentation: "popover" | "sheet"
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  value: ImageSettings
  imageModels: string[]
  onChange: (change: Partial<ImageSettings>) => void
}

type ImageSettingsFieldsProps = Pick<
  ImageSettingsPanelProps,
  "value" | "imageModels" | "onChange"
> & {
  showHeading: boolean
}

function ImageSettingsFields({
  value,
  imageModels,
  onChange,
  showHeading,
}: ImageSettingsFieldsProps) {
  const selectedModelLabel = imageModels.find((model) => model === value.model) || value.model

  return (
    <div className="p-4">
      {showHeading ? <h3 className="mb-3 text-base font-semibold text-stone-950">图像设置</h3> : null}
      <div className="mb-3">
        <div className="mb-2 text-sm font-medium text-stone-900">模型</div>
        <Select value={value.model} onValueChange={(model) => onChange({ model })}>
          <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white text-sm shadow-none">
            <div className="flex min-w-0 items-center gap-2">
              <img
                src={withBasePath("/openai.svg")}
                alt=""
                aria-hidden="true"
                className="size-4 shrink-0 text-stone-700"
              />
              <span className="truncate">{selectedModelLabel}</span>
            </div>
          </SelectTrigger>
          <SelectContent className="z-[120]">
            {imageModels.map((model) => (
              <SelectItem
                key={model}
                value={model}
                className="pl-10"
                style={{
                  backgroundImage: `url('${withBasePath("/openai.svg")}')`,
                  backgroundRepeat: "no-repeat",
                  backgroundPosition: "12px center",
                  backgroundSize: "16px 16px",
                }}
              >
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mb-3">
        <div className="mb-2 text-sm font-medium text-stone-900">质量</div>
        <div className="grid grid-cols-4 gap-2">
          {qualityOptions.map((option) => {
            const active = option.value === value.quality
            return (
              <button
                key={option.value}
                type="button"
                className={cn(
                  "h-9 cursor-pointer rounded-full border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                  active && "border-stone-950 bg-white font-medium text-stone-950",
                )}
                onClick={() => onChange({ quality: option.value })}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-stone-900">
          尺寸 <Info className="size-3.5 text-stone-400" />
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="flex items-center rounded-lg bg-stone-100 px-3 py-1.5 text-sm text-stone-700">
            <span className="mr-2 text-stone-500">W</span>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              value={value.width}
              onChange={(event) => onChange({ width: event.target.value })}
              aria-label="自定义宽度"
              className="h-7 border-0 bg-transparent px-0 text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
            />
          </div>
          <span className="text-stone-400">×</span>
          <div className="flex items-center rounded-lg bg-stone-100 px-3 py-1.5 text-sm text-stone-700">
            <span className="mr-2 text-stone-500">H</span>
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              value={value.height}
              onChange={(event) => onChange({ height: event.target.value })}
              aria-label="自定义高度"
              className="h-7 border-0 bg-transparent px-0 text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
      </div>

      <div className="mb-3">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-stone-900">
          宽高比 <Info className="size-3.5 text-stone-400" />
        </div>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {aspectOptions.map((option) => {
            const active =
              option.ratio === value.ratio &&
              option.tier === value.tier &&
              option.width === value.width &&
              option.height === value.height
            const Icon = option.icon
            const disabled = isImagePresetDisabled(value.model, option.tier)

            return (
              <button
                key={`${option.ratio}-${option.tier}-${option.label}`}
                type="button"
                disabled={disabled}
                className={cn(
                  "flex h-[64px] cursor-pointer flex-col items-center justify-center gap-1 rounded-2xl border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                  active && "border-stone-950",
                  disabled &&
                    "cursor-not-allowed border-stone-100 bg-stone-50 text-stone-300 hover:border-stone-100 hover:bg-stone-50",
                )}
                onClick={() => {
                  if (disabled) {
                    return
                  }
                  onChange({
                    ratio: option.ratio,
                    tier: option.tier,
                    width: option.width,
                    height: option.height,
                  })
                }}
              >
                {Icon ? (
                  <>
                    <Icon className="size-3.5 stroke-[1.8]" />
                    <span>{option.label}</span>
                  </>
                ) : (
                  <span>{option.label}</span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      <div className="border-t border-stone-100 pt-3">
        <div className="mb-2 text-sm font-medium text-stone-900">生成数量</div>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
          {countOptions.map((option) => {
            const active = value.count === option
            return (
              <button
                key={option}
                type="button"
                className={cn(
                  "h-9 cursor-pointer rounded-full border border-stone-200 bg-white text-sm text-stone-800 transition hover:border-stone-300 hover:bg-stone-50",
                  active && "border-stone-950 bg-white font-medium text-stone-950",
                )}
                onClick={() => onChange({ count: option })}
              >
                {option} 张
              </button>
            )
          })}
          <Input
            type="number"
            inputMode="numeric"
            min="1"
            max="100"
            step="1"
            value={value.count}
            onChange={(event) => onChange({ count: event.target.value })}
            aria-label="自定义生成数量"
            className="h-9 rounded-full border-stone-200 bg-white px-3 text-center text-sm font-medium text-stone-800 shadow-none focus-visible:ring-0"
          />
        </div>
      </div>
    </div>
  )
}

export function ImageSettingsPanel({
  presentation,
  open,
  onOpenChange,
  trigger,
  value,
  imageModels,
  onChange,
}: ImageSettingsPanelProps) {
  if (presentation === "sheet") {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 overflow-y-auto rounded-t-[24px] border-stone-200 bg-white p-0 text-stone-950"
        >
          <SheetHeader className="pb-0">
            <SheetTitle className="text-base text-stone-950">图像设置</SheetTitle>
            <SheetDescription className="sr-only">选择图片模型、质量、尺寸和生成数量</SheetDescription>
          </SheetHeader>
          <ImageSettingsFields
            value={value}
            imageModels={imageModels}
            onChange={onChange}
            showHeading={false}
          />
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={16}
        className="z-[80] max-h-[62dvh] overflow-y-auto rounded-[24px] border-stone-200/70 bg-white p-0 shadow-[0_30px_90px_-34px_rgba(15,23,42,0.42)] sm:max-h-none sm:overflow-visible"
        style={{ width: "min(460px, calc(100vw - 2rem))" }}
      >
        <ImageSettingsFields
          value={value}
          imageModels={imageModels}
          onChange={onChange}
          showHeading
        />
      </PopoverContent>
    </Popover>
  )
}
