import standardUrl from "./standard.css";

// Retain persisted setting compatibility; all clients now use one product theme.
export type PageStyle = "standard" | "old" | "moonlight";

let loaded = false
export function setStyle(_style: PageStyle) {
    if (loaded) return
    standardUrl.use()
    loaded = true
}

export function getStyle(): PageStyle {
    return "standard"
}

setStyle("standard")
