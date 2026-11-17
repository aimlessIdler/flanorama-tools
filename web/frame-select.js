import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const activeReviews = new Map();
const endpoint = (token) => `/flanodes/frame-review/${encodeURIComponent(token)}`;

app.registerExtension({
    name: "flanodes.frame_select",
    setup() {
        const style = document.createElement("link");
        style.rel = "stylesheet";
        style.href = new URL("./frame-select.css", import.meta.url);
        document.head.append(style);

        api.addEventListener("flanodes.review_opened", ({ detail: { token } }) => {
            const controller = new AbortController();
            activeReviews.set(token, controller);
            showReview(token, controller.signal).catch((error) => {
                if (!controller.signal.aborted) {
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Frame preview unavailable",
                        detail: `${error.message} Interrupt the queue to end this review.`,
                    });
                }
            });
        });
        api.addEventListener("flanodes.review_closed", ({ detail: { token } }) => {
            activeReviews.get(token)?.abort();
            activeReviews.delete(token);
        });
    },
});

async function showReview(token, signal) {
    const response = await api.fetchApi(endpoint(token), { signal });
    if (!response.ok) throw new Error(`Could not load frames (${response.status}).`);
    const { frames, start_index, batch_size, scene_name, next_scene_name } = await response.json();
    if (signal.aborted) return;

    const dialog = document.createElement("dialog");
    dialog.className = "fla-frame-review";
    dialog.setAttribute("aria-label", "Choose the scene handoff frame");
    const heading = document.createElement("h2");
    heading.textContent = [scene_name, next_scene_name].filter(Boolean).join(" → ") || "Select handoff frame";
    const image = document.createElement("img");
    const counter = document.createElement("output");
    counter.setAttribute("aria-live", "polite");
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(frames.length - 1);
    slider.value = slider.max;
    slider.setAttribute("aria-label", "Frame in review window");
    const controls = document.createElement("div");
    controls.className = "fla-frame-controls";
    const error = document.createElement("p");
    error.className = "fla-frame-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const previous = button("Previous", () => navigate(-1));
    const next = button("Next", () => navigate(1));
    const select = button("Use frame", () => submit(Number(slider.value)));
    select.className = "fla-frame-primary";
    const cancel = button("Cancel review", () => submit(null));
    controls.append(previous, next, cancel, select);
    dialog.append(heading, image, counter, slider, error, controls);

    function render() {
        const index = Number(slider.value);
        const label = `Frame ${start_index + index + 1} of ${batch_size}`;
        image.src = `data:image/jpeg;base64,${frames[index]}`;
        image.alt = label;
        counter.textContent = label;
        previous.disabled = index === 0;
        next.disabled = index === frames.length - 1;
    }

    function navigate(offset) {
        slider.value = String(Math.max(0, Math.min(frames.length - 1, Number(slider.value) + offset)));
        render();
    }

    let submitting = false;
    async function submit(index) {
        if (submitting) return;
        submitting = true;
        select.disabled = cancel.disabled = true;
        error.hidden = true;
        try {
            const result = await api.fetchApi(endpoint(token), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ index }),
                signal,
            });
            if (!result.ok && result.status !== 404) {
                throw new Error(`Could not submit selection (${result.status}). Try again.`);
            }
            dialog.remove();
        } catch (failure) {
            if (signal.aborted) return;
            error.textContent = failure.message;
            error.hidden = false;
        } finally {
            submitting = false;
            select.disabled = cancel.disabled = false;
        }
    }

    slider.addEventListener("input", render);
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        submit(null);
    });
    dialog.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.target === slider || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        navigate(event.key === "ArrowLeft" ? -1 : 1);
    });
    signal.addEventListener("abort", () => dialog.remove(), { once: true });
    document.body.append(dialog);
    render();
    dialog.showModal();
    slider.focus();
}

function button(label, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", action);
    return element;
}
