import { Component } from "./index"
import { ERROR_IMAGE, INFO_IMAGE, WARN_IMAGE } from "../resources/index"
import { ListComponent } from "./list"

type NotificationLevel = "error" | "warn" | "info"
export type NotificationHandle = { dismiss(): void }

const ERROR_REMOVAL_TIME_MS = 10000

const notificationListElement = document.getElementById("notification-list")
const notificationListComponent = new ListComponent<NotificationComponent>([], { listClasses: ["notification-list"], elementLiClasses: ["notification-element"] })
if (notificationListElement) {
    notificationListComponent.mount(notificationListElement)
}

let alertedNotificationListNotFound = false

export function showNotification(message: string, level: NotificationLevel = "error", errorObject?: any): NotificationHandle {
    if (level === "info") console.info(message, errorObject)
    else if (level === "warn") console.warn(message, errorObject)
    else console.error(message, errorObject)

    if (!notificationListElement) {
        if (!alertedNotificationListNotFound) {
            alert("couldn't find the notification element")
            alertedNotificationListNotFound = true
        }
        alert(message)
        return { dismiss() { } };
    }

    let error: NotificationComponent
    if (level == "error") {
        error = new NotificationComponent(message, ERROR_IMAGE, level)
    } else if (level == "warn") {
        error = new NotificationComponent(message, WARN_IMAGE, level)
    } else if (level === "info") {
        error = new NotificationComponent(message, INFO_IMAGE, level)
    } else {
        error = new NotificationComponent(`Unknown notification level (\"${level}\") for message: ${message}`, ERROR_IMAGE, "error")
    }

    let dismissed = false
    let removalTimer: ReturnType<typeof setTimeout> | undefined
    const dismiss = () => {
        if (dismissed) return
        dismissed = true
        if (removalTimer !== undefined) clearTimeout(removalTimer)
        error.removeDismissListener(dismiss)
        notificationListComponent.removeValue(error)
    }
    error.addDismissListener(dismiss)
    notificationListComponent.append(error)
    removalTimer = setTimeout(dismiss, ERROR_REMOVAL_TIME_MS)
    return { dismiss }
}

function handleError(event: ErrorEvent) {
    showNotification(`${event.error}`, "error", event)
}
function handleRejection(event: PromiseRejectionEvent) {
    showNotification(`${event.reason}`, "error", event)
}

window.addEventListener("error", handleError)
window.addEventListener("unhandledrejection", handleRejection)

class NotificationComponent implements Component {
    private messageElement: HTMLElement = document.createElement("p")
    private imageElement: HTMLImageElement = document.createElement("img")

    constructor(message: string, image: string, private readonly level: NotificationLevel) {
        this.messageElement.innerText = message
        this.messageElement.classList.add("notification-message")

        this.imageElement.src = image
        this.imageElement.classList.add("notification-image")
    }

    addDismissListener(listener: () => void) {
        this.messageElement.addEventListener("click", listener)
        this.imageElement.addEventListener("click", listener)
    }
    removeDismissListener(listener: () => void) {
        this.messageElement.removeEventListener("click", listener)
        this.imageElement.removeEventListener("click", listener)
    }

    mount(parent: Element): void {
        parent.setAttribute("data-notification-level", this.level)
        parent.appendChild(this.imageElement)
        parent.appendChild(this.messageElement)
    }
    unmount(parent: Element): void {
        parent.removeAttribute("data-notification-level")
        parent.removeChild(this.imageElement)
        parent.removeChild(this.messageElement)
    }
}
