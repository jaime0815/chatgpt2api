import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Model } from "@/lib/api"

import { groupModelsByProvider } from "./model-provider"

type ModelCatalogCardProps = {
  models: Model[]
  isLoading: boolean
  isRefreshing: boolean
  onRefresh: () => void
  onCopy: (modelId: string) => void
}

export function ModelCatalogCard({
  models,
  isLoading,
  isRefreshing,
  onRefresh,
  onCopy,
}: ModelCatalogCardProps) {
  const refreshLabel = isRefreshing ? "正在刷新系统模型" : "刷新系统模型"
  const providerGroups = groupModelsByProvider(models)

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-sm font-medium text-stone-700">
          系统可用模型
          <span className="ml-1 text-stone-400">({models.length})</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-stone-500 hover:bg-stone-100 hover:text-stone-900"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={refreshLabel}
          title={refreshLabel}
        >
          <RefreshCw className={isRefreshing ? "size-4 animate-spin" : "size-4"} />
        </Button>
      </div>
      <div className="space-y-4" aria-live="polite">
        {models.length > 0 ? (
          providerGroups.map((group, index) => (
            <section
              key={group.id}
              className={index > 0 ? "border-t border-stone-100 pt-4" : undefined}
              aria-labelledby={`model-provider-${group.id}`}
            >
              <h3
                id={`model-provider-${group.id}`}
                className="mb-2 text-xs font-medium text-stone-500"
              >
                {group.label}
                <span className="ml-1 text-stone-400">({group.models.length})</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {group.models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    className="inline-flex cursor-pointer items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-400 focus-visible:ring-offset-2"
                    onClick={() => onCopy(model.id)}
                    aria-label={`复制模型 ${model.id}`}
                    title={`点击复制 ${model.id}`}
                  >
                    {model.id}
                  </button>
                ))}
              </div>
            </section>
          ))
        ) : isLoading ? (
          <span className="text-sm text-stone-400">正在加载模型列表...</span>
        ) : (
          <span className="text-sm text-stone-400">当前暂无可用模型</span>
        )}
      </div>
    </div>
  )
}
