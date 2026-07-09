import webConfig from "@/constants/common-env"

const ABSOLUTE_URL_PATTERN = /^[a-z][a-z\d+\-.]*:/i

export function withBasePath(path: string) {
  if (!path) {
    return webConfig.basePath || "/"
  }
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith("//")) {
    return path
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  if (webConfig.basePath && (normalizedPath === webConfig.basePath || normalizedPath.startsWith(`${webConfig.basePath}/`))) {
    return normalizedPath
  }
  return `${webConfig.basePath}${normalizedPath}`
}

export function getApiBaseUrl(origin = "") {
  if (webConfig.apiUrl) {
    return webConfig.apiUrl
  }
  const normalizedOrigin = origin.replace(/\/$/, "")
  return `${normalizedOrigin}${webConfig.basePath}`
}

export function withApiBasePath(path: string, origin = "") {
  if (ABSOLUTE_URL_PATTERN.test(path) || path.startsWith("//")) {
    return path
  }
  const normalizedPath = path.startsWith("/") ? path : `/${path}`
  if (!webConfig.apiUrl && webConfig.basePath && (normalizedPath === webConfig.basePath || normalizedPath.startsWith(`${webConfig.basePath}/`))) {
    return `${origin.replace(/\/$/, "")}${normalizedPath}`
  }
  return `${getApiBaseUrl(origin)}${normalizedPath}`
}
