/**
 * Pure helpers for the hero carousel: momentum projection, snap choice, spring integration and the
 * per-slide visual state. No DOM access, so every function is unit-testable.
 * Motion model: Apple, "Designing Fluid Interfaces" (WWDC 2018): projection, velocity hand-off, springs.
 */

/** Scroll-like deceleration used to project where a flick would come to rest. */
export const DECELERATION_RATE = 0.998;
/** Release speed (px/s) from which the gesture counts as a flick: the spring may then overshoot a little. */
export const FLICK_MIN_VELOCITY = 500;
/** Release speed (px/s) at which a single flick may travel two slides. */
export const FAST_FLICK_VELOCITY = 2800;
/** Only pointer samples this recent (ms) shape the release velocity. */
export const VELOCITY_WINDOW_MS = 100;
/** Damping for a settle with no momentum: critically damped, no overshoot. */
export const DAMPING_DEFAULT = 1;
/** Damping after a flick: a hint of bounce, because the gesture carried momentum. */
export const DAMPING_FLICK = 0.8;
/** Spring response in seconds (time scale of the motion, not a duration). */
export const SPRING_RESPONSE_S = 0.45;
/** Scale of a slide one step away from the centre. */
export const SIDE_SCALE = 0.86;
/** Opacity of a slide one step away from the centre. */
export const SIDE_OPACITY = 0.5;
/** Distance (in slides) beyond which a slide is fully faded out, so a wrap-around jump is never seen. */
export const FADE_OUT_DISTANCE = 1.5;
/** Rate at which slide copy fades while the slide leaves the centre. */
const CONTENT_FADE_RATE = 1.6;
const RUBBER_BAND_CONSTANT = 0.55;
const REST_DELTA = 0.0005;
const REST_VELOCITY = 0.005;
const CRITICAL_EPSILON = 1e-6;
const MS_PER_SECOND = 1000;
const MAX_STEP = 1;
const MAX_STEP_FAST = 2;
const MIN_LOOP_COUNT = 3;
const CENTER_Z_INDEX = 10;

export interface PointerSample {
    x: number;
    t: number;
}

export interface SpringState {
    value: number;
    velocity: number;
}

export interface SpringParams {
    /** 1 is critically damped; below 1 overshoots. */
    damping: number;
    /** Seconds; lower is snappier. */
    response: number;
}

export interface SlideVisual {
    scale: number;
    opacity: number;
    contentOpacity: number;
    zIndex: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** Modulo that stays in [0, m) for negative numbers. */
export function mod(n: number, m: number): number {
    return ((n % m) + m) % m;
}

/** Whether a carousel with this many slides loops. Fewer than three would show one slide on both sides. */
export function canLoop(count: number): boolean {
    return count >= MIN_LOOP_COUNT;
}

/** Signed distance from the centre in slides, taking the shortest way round when the carousel loops. */
export function wrapDistance(distance: number, count: number, loop = canLoop(count)): number {
    if (!loop) return distance;
    return distance - count * Math.round(distance / count);
}

/** Apple's projection: where a pointer moving at `velocityPxPerS` would come to rest (px, signed). */
export function projectMomentum(velocityPxPerS: number, rate = DECELERATION_RATE): number {
    return (velocityPxPerS / MS_PER_SECOND) * rate / (1 - rate);
}

/** Release velocity (px/s) from the recent pointer history. Zero when the pointer rested before release. */
export function velocityFromSamples(samples: readonly PointerSample[], releaseTime: number): number {
    const last = samples[samples.length - 1];
    if (!last || releaseTime - last.t > VELOCITY_WINDOW_MS) return 0;
    const first = samples.find(sample => last.t - sample.t <= VELOCITY_WINDOW_MS);
    if (!first || first === last) return 0;
    const seconds = (last.t - first.t) / MS_PER_SECOND;
    return seconds > 0 ? (last.x - first.x) / seconds : 0;
}

/**
 * The slide to settle on after a release.
 * @param current index of the slide the drag started from (may be unwrapped)
 * @param offsetPx how far the content is dragged right of where `current` sits (positive shows the previous slide)
 * @param velocityPxPerS pointer velocity at release, positive = moving right
 * @param slideWidth distance in px between neighbouring slide centres
 * @param count number of slides
 * @returns the target index, unwrapped when the carousel loops (so the spring takes the short way)
 */
export function pickSnapIndex(
    current: number,
    offsetPx: number,
    velocityPxPerS: number,
    slideWidth: number,
    count: number,
    loop = canLoop(count)
): number {
    if (count < 2 || slideWidth <= 0) return current;
    const projected = offsetPx + projectMomentum(velocityPxPerS);
    const maxStep = Math.abs(velocityPxPerS) >= FAST_FLICK_VELOCITY ? MAX_STEP_FAST : MAX_STEP;
    // Dragging right reveals the previous slide, so the index moves the other way.
    const delta = clamp(Math.round(-projected / slideWidth) || 0, -maxStep, maxStep);
    const target = current + delta;
    return loop ? target : clamp(target, 0, count - 1);
}

/** Damping for the settle: bounce only when the release carried momentum. */
export function dampingForRelease(velocityPxPerS: number): number {
    return Math.abs(velocityPxPerS) >= FLICK_MIN_VELOCITY ? DAMPING_FLICK : DAMPING_DEFAULT;
}

/**
 * Advance a damped spring by `dt` seconds using the exact solution, so any frame time is stable.
 * Mass is 1; stiffness and damping derive from Apple's (response, dampingRatio) pair.
 */
export function stepSpring(state: SpringState, target: number, params: SpringParams, dt: number): SpringState {
    if (dt <= 0) return state;
    const omega = (2 * Math.PI) / params.response;
    const zeta = params.damping;
    const offset = state.value - target;
    const v = state.velocity;

    if (Math.abs(zeta - 1) < CRITICAL_EPSILON) {
        const decay = Math.exp(-omega * dt);
        const carry = v + omega * offset;
        return {
            value: target + decay * (offset + carry * dt),
            velocity: decay * (v - omega * carry * dt)
        };
    }

    if (zeta < 1) {
        const decay = Math.exp(-zeta * omega * dt);
        const damped = omega * Math.sqrt(1 - zeta * zeta);
        const b = (v + zeta * omega * offset) / damped;
        const cos = Math.cos(damped * dt);
        const sin = Math.sin(damped * dt);
        const wave = offset * cos + b * sin;
        return {
            value: target + decay * wave,
            velocity: decay * (-zeta * omega * wave + damped * (b * cos - offset * sin))
        };
    }

    const root = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + root;
    const r2 = -zeta * omega - root;
    const c2 = (v - r1 * offset) / (r2 - r1);
    const c1 = offset - c2;
    const e1 = Math.exp(r1 * dt);
    const e2 = Math.exp(r2 * dt);
    return {
        value: target + c1 * e1 + c2 * e2,
        velocity: c1 * r1 * e1 + c2 * r2 * e2
    };
}

/** True when the spring is close enough to its target, and slow enough, to snap and stop animating. */
export function isSpringAtRest(state: SpringState, target: number): boolean {
    return Math.abs(state.value - target) < REST_DELTA && Math.abs(state.velocity) < REST_VELOCITY;
}

/** Progressive resistance past an edge (Apple's rubber band): the further out, the less the content follows. */
export function rubberBand(overshoot: number, dimension: number, constant = RUBBER_BAND_CONSTANT): number {
    if (overshoot === 0 || dimension <= 0) return 0;
    const sign = Math.sign(overshoot);
    const magnitude = Math.abs(overshoot);
    return sign * (magnitude * dimension * constant) / (dimension + constant * magnitude);
}

/** Position (in slides) that follows the pointer, with progressive resistance past either end of a non-looping carousel. */
export function constrainPosition(raw: number, stride: number, count: number): number {
    if (canLoop(count)) return raw;
    const last = count - 1;
    if (raw < 0) return -rubberBand(-raw * stride, stride) / stride;
    if (raw > last) return last + rubberBand((raw - last) * stride, stride) / stride;
    return raw;
}

/**
 * Visual state of a slide from its signed distance to the centre (in slides). Continuous, so neighbours
 * grow and fade in step with the drag. Beyond one step the slide fades out entirely, which hides the
 * jump when it wraps to the other side.
 */
export function slideVisual(distance: number): SlideVisual {
    const away = Math.abs(distance);
    const near = Math.min(away, 1);
    const fade = away <= 1 ? 1 : clamp(1 - (away - 1) / (FADE_OUT_DISTANCE - 1), 0, 1);
    return {
        scale: 1 - (1 - SIDE_SCALE) * near,
        opacity: (1 - (1 - SIDE_OPACITY) * near) * fade,
        contentOpacity: clamp(1 - away * CONTENT_FADE_RATE, 0, 1),
        zIndex: Math.round((1 - near) * CENTER_Z_INDEX)
    };
}

/** Gap in px between neighbouring cards. */
export const SLIDE_GAP_PX = 16;
/** Distance between neighbouring card centres as a fraction of the card width (neighbours are scaled down). */
export const STRIDE_FRACTION = (1 + SIDE_SCALE) / 2;
const PERCENT = 100;
const STYLE_PRECISION = 1000;
/** Below this opacity a card is visually gone and must not catch pointer events. */
const MIN_INTERACTIVE_OPACITY = 0.1;
/** Pointer travel before a press turns into a horizontal drag (Apple: ~10px hysteresis). */
export const DRAG_THRESHOLD_PX = 10;
const POINTER_SAMPLES_KEPT = 12;
const MAX_FRAME_SECONDS = 1 / 30;
const FIRST_FRAME_SECONDS = 1 / 60;

function roundStyle(value: number): number {
    return Math.round(value * STYLE_PRECISION) / STYLE_PRECISION;
}

export interface SlideStyle {
    transform: string;
    opacity: string;
    zIndex: string;
    /** Empty string means "leave to the stylesheet". */
    pointerEvents: string;
    /** Null means "remove the inline value". */
    contentOpacity: string | null;
}

/**
 * Inline style for a card at a signed distance from the centre. Cards are centred by CSS (`left: 50%`), so the
 * translate is in percent of the card's own width plus a pixel gap; both scale with `distance`.
 */
export function slideStyle(distance: number): SlideStyle {
    const visual = slideVisual(distance);
    const percent = roundStyle(-PERCENT / 2 + distance * STRIDE_FRACTION * PERCENT);
    const gap = roundStyle(distance * SLIDE_GAP_PX);
    return {
        transform: `translate3d(${percent}%, 0, 0) translate3d(${gap}px, 0, 0) scale(${roundStyle(visual.scale)})`,
        opacity: String(roundStyle(visual.opacity)),
        zIndex: String(visual.zIndex),
        pointerEvents: visual.opacity < MIN_INTERACTIVE_OPACITY ? 'none' : '',
        contentOpacity: visual.contentOpacity >= 1 ? null : String(roundStyle(visual.contentOpacity))
    };
}

/** Runs a spring on requestAnimationFrame. Re-targeting starts from the live value, so it is always interruptible. */
export class SpringAnimator {
    private state: SpringState = { value: 0, velocity: 0 };
    private target = 0;
    private params: SpringParams = { damping: DAMPING_DEFAULT, response: SPRING_RESPONSE_S };
    private frameId: number | undefined;
    private lastTime = -1;

    constructor(
        private readonly onUpdate: (value: number) => void,
        private readonly onSettle: (target: number) => void
    ) {}

    get running(): boolean {
        return this.frameId !== undefined;
    }

    /** Velocity (value units per second) of the spring in flight, or zero when idle. */
    get velocity(): number {
        return this.running ? this.state.velocity : 0;
    }

    /** Begin moving from `from` to `target`. Settles at once when there is nothing to animate. */
    start(from: number, target: number, velocity: number, params: SpringParams): void {
        this.stop();
        this.state = { value: from, velocity };
        this.target = target;
        this.params = params;
        if (isSpringAtRest(this.state, target)) {
            this.onSettle(target);
            return;
        }
        this.lastTime = -1;
        this.frameId = requestAnimationFrame(this.frame);
    }

    stop(): void {
        if (this.frameId !== undefined) cancelAnimationFrame(this.frameId);
        this.frameId = undefined;
    }

    private readonly frame = (now: number): void => {
        this.frameId = undefined;
        const seconds = this.lastTime < 0 ? FIRST_FRAME_SECONDS : Math.min((now - this.lastTime) / MS_PER_SECOND, MAX_FRAME_SECONDS);
        this.lastTime = now;
        this.state = stepSpring(this.state, this.target, this.params, seconds);
        if (isSpringAtRest(this.state, this.target)) {
            this.onSettle(this.target);
            return;
        }
        this.onUpdate(this.state.value);
        this.frameId = requestAnimationFrame(this.frame);
    };
}

export type DragUpdate = 'pending' | 'abandon' | 'start' | 'drag';

/** Tracks one pointer through press, hysteresis, 1:1 drag and release. DOM-free. */
export class DragGesture {
    private active = false;
    private originX: number;
    private originPosition: number;
    private samples: PointerSample[] = [];

    constructor(
        readonly pointerId: number,
        private readonly startX: number,
        private readonly startY: number,
        position: number,
        /** Distance in px between neighbouring card centres. */
        readonly stride: number,
        /** True when the press caught a card that was still moving. */
        readonly interrupted: boolean
    ) {
        this.originX = startX;
        this.originPosition = position;
    }

    get isDragging(): boolean {
        return this.active;
    }

    /**
     * Feed a pointer move. Stays 'pending' inside the threshold, returns 'abandon' when the press turns out
     * vertical (page scroll wins), 'start' on the move that commits to a horizontal drag, then 'drag'.
     */
    move(x: number, y: number, time: number, currentPosition: number): DragUpdate {
        let update: DragUpdate = 'drag';
        if (!this.active) {
            const dx = Math.abs(x - this.startX);
            const dy = Math.abs(y - this.startY);
            if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return 'pending';
            if (dy > dx) return 'abandon';
            // Track from the point where the drag began so the card does not jump by the threshold.
            this.active = true;
            this.originX = x;
            this.originPosition = currentPosition;
            update = 'start';
        }
        this.samples.push({ x, t: time });
        if (this.samples.length > POINTER_SAMPLES_KEPT) this.samples.shift();
        return update;
    }

    /** The unconstrained position (in slides) that keeps the content under the pointer. */
    positionAt(x: number): number {
        return this.originPosition - (x - this.originX) / this.stride;
    }

    releaseVelocity(time: number): number {
        return velocityFromSamples(this.samples, time);
    }
}
