let report: ((error: unknown) => void) | undefined
export const applicationAssetUrl = import.meta.url
export const setExceptionReporter = (next?: (error: unknown) => void) => {
  report = next
}
export const reportCaughtException = (error: unknown) => {
  report?.(error)
}
