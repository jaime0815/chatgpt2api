import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { Model } from "@/lib/api"
import { withBasePath } from "@/lib/paths"

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
      <div className="flex flex-wrap gap-2">
        {models.length > 0 ? (
          models.map((model) => (
            <button
              key={model.id}
              type="button"
              className="inline-flex cursor-pointer items-center rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-300 hover:bg-stone-50"
              onClick={() => onCopy(model.id)}
              title={`点击复制 ${model.id}`}
            >
              <img
                src={withBasePath("/openai.svg")}
                alt=""
                aria-hidden="true"
                className="mr-1.5 size-3.5 shrink-0"
              />
              {model.id}
            </button>
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
