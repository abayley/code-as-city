"use client";

// The three.js city-map viewer: the react-three-fiber scene (camera rig,
// district plots, structures, edges) plus the surrounding UI chrome (rail,
// inspector, map picker, folder browser).
import { Line, MapControls, Text } from "@react-three/drei";
import { Canvas, type ThreeEvent, useFrame, useThree } from "@react-three/fiber";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { configureTextBuilder } from "troika-three-text";
import { EmptyState } from "./components/empty-state";
import { FolderBrowser } from "./components/folder-browser";
import { HoverDetails, type HoverFact } from "./components/hover-details";
import { Inspector, type InspectorContent, type InspectorSource, type InspectorStat } from "./components/inspector";
import { Legend } from "./components/legend";
import { Sidebar, type SidebarSection } from "./components/sidebar";
import { Topbar } from "./components/topbar";
import { ViewportOverlays } from "./components/viewport-overlays";
import type { CityEdge, CityMap, CityNode, EvidenceKind, SourceRef } from "./lib/city-map";
import { validateCityMap } from "./lib/city-map";
import { computeFlowLayout, createEdgeRouter, type FlowLayout } from "./lib/flow-layout";
import { type Showcase, showcases } from "./lib/local-showcases";
import * as palette from "./lib/palette";
import { type Theme, useTheme } from "./lib/theme";

// Vinext's production bundle cannot serialize Troika's typesetting worker.
// Main-thread typesetting keeps labels functional without the broken worker.
configureTextBuilder({ useWorker: false });

const SCENE_INK = palette.INK;
const SCENE_PAPER = palette.PAPER;
const SCENE_PAPER_DARK = palette.PAPER_DARK;
const SCENE_INK_ON_DARK = palette.INK_ON_DARK;
const SCENE_PANEL = palette.PANEL;
const NEIGHBORHOOD_ACCENTS = palette.NEIGHBORHOOD_ACCENTS;

const IMPORTS_OUT_COLOR = palette.IMPORTS_OUT;
/**
 * Edge colours by evidence kind. Declared and inferred data flow both draw
 * in ink, so they take the canvas-facing ink of the active theme; observed
 * evidence keeps its own green in both.
 *
 * @param ink - The ink that reads against the current canvas background.
 * @returns The colour to draw each evidence kind in.
 */
function evidenceColors(ink: string): Record<EvidenceKind, string> {
    return {
        declared: ink,
        observed: palette.EDGE_OBSERVED,
        inferred: ink,
    };
}

/**
 * Drives the orthographic camera: fits it to the current view's bounds, flies
 * it between the isometric and overhead orientations, and hands control back
 * to the user as soon as they grab the controls.
 *
 * @param props - `viewKey` identifies the current view so a view change refits
 *   even with unchanged bounds; `bounds` is the layout box to frame;
 *   `overhead` selects the top-down orientation instead of the isometric one.
 * @returns Nothing visible; it only mutates the camera inside the frame loop.
 */
function CameraRig({
    viewKey,
    bounds,
    overhead,
}: {
    viewKey: string;
    bounds: FlowLayout["bounds"];
    overhead: boolean;
}) {
    const camera = useThree((state) => state.camera);
    const controls = useThree((state) => state.controls) as {
        target?: THREE.Vector3;
        update?: () => void;
        addEventListener?: (type: "start", listener: () => void) => void;
        removeEventListener?: (type: "start", listener: () => void) => void;
    } | null;
    const viewportSize = useThree((state) => state.size);
    const targetPosition = useRef(camera.position.clone());
    const currentTarget = useRef(new THREE.Vector3());
    const targetLookAt = useRef(new THREE.Vector3());
    const targetZoom = useRef(camera instanceof THREE.OrthographicCamera ? camera.zoom : 48);
    const targetQuaternion = useRef(new THREE.Quaternion());
    const reduceMotion = useRef(false);
    const fitting = useRef(true);

    useEffect(() => {
        reduceMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }, []);

    useEffect(() => {
        const releaseCamera = () => {
            fitting.current = false;
        };
        controls?.addEventListener?.("start", releaseCamera);
        return () => controls?.removeEventListener?.("start", releaseCamera);
    }, [controls]);

    const previousOverhead = useRef(overhead);
    useEffect(() => {
        // A view change must refit even when the bounds object is unchanged,
        // so the view key participates in the effect.
        void viewKey;
        const centerX = (bounds.minX + bounds.maxX) / 2;
        const centerZ = (bounds.minZ + bounds.maxZ) / 2;
        const spanX = Math.max(4, bounds.maxX - bounds.minX);
        const spanZ = Math.max(4, bounds.maxZ - bounds.minZ);
        // Distance must exceed the layout's bounding radius or the orthographic
        // near plane clips the front of a large map.
        const boundingRadius = Math.hypot(spanX, spanZ) / 2;
        const distance = Math.max(23.5, boundingRadius * 1.4 + 12);
        // Overhead looks (imperceptibly short of) straight down; the tiny tilt is
        // purely along +Z so screen-up is exactly -Z and nameplates read
        // horizontal, and it keeps the lookAt matrix non-degenerate. Roll is NOT
        // derived from lookAt during the flight — the target orientation is
        // computed once here and the frame loop slerps to it.
        if (overhead) {
            targetPosition.current.set(centerX, distance, centerZ + 0.2);
        } else {
            const direction = new THREE.Vector3(11, 14, 15).normalize();
            targetPosition.current.set(
                centerX + direction.x * distance,
                direction.y * distance,
                centerZ + direction.z * distance,
            );
        }
        targetLookAt.current.set(centerX, 0.35, centerZ);
        targetQuaternion.current.setFromRotationMatrix(
            new THREE.Matrix4().lookAt(targetPosition.current, targetLookAt.current, new THREE.Vector3(0, 1, 0)),
        );
        const overheadToggled = previousOverhead.current !== overhead;
        previousOverhead.current = overhead;
        if (camera instanceof THREE.OrthographicCamera) {
            // A view flip keeps the user's current zoom; only a new view/bounds refits.
            targetZoom.current = overheadToggled
                ? camera.zoom
                : Math.max(
                      4,
                      Math.min(
                          78,
                          Math.min(viewportSize.width / (spanX + 6), viewportSize.height / (spanZ + 7)) * 0.92,
                      ),
                  );
        }
        fitting.current = true;
    }, [bounds, camera, overhead, viewKey, viewportSize.height, viewportSize.width]);

    // React Three Fiber scene objects are intentionally updated inside the render loop.
    // eslint-disable-next-line react-hooks/immutability
    useFrame((_, delta) => {
        if (!fitting.current) return;
        const blend = reduceMotion.current ? 1 : 1 - Math.exp(-delta * 7.5);
        camera.position.lerp(targetPosition.current, blend);
        currentTarget.current.lerp(targetLookAt.current, blend);
        // Slerp orientation directly instead of lookAt: near-vertical lookAt roll
        // is hypersensitive to the remaining travel and reads as a slow, skewed
        // second phase. Controls are not updated mid-flight (their update() would
        // re-derive the roll); they re-sync at the snap below.
        camera.quaternion.slerp(targetQuaternion.current, blend);
        if (controls?.target) controls.target.copy(currentTarget.current);
        if (camera instanceof THREE.OrthographicCamera) {
            // eslint-disable-next-line react-hooks/immutability
            camera.zoom = THREE.MathUtils.damp(camera.zoom, targetZoom.current, reduceMotion.current ? 1000 : 8, delta);
            camera.updateProjectionMatrix();
        }
        // Settle early and snap: the exponential tail is where the near-vertical
        // roll straightens, and letting it play out reads as a slow second phase.
        const positionSettled = camera.position.distanceToSquared(targetPosition.current) < 0.0025;
        const targetSettled = currentTarget.current.distanceToSquared(targetLookAt.current) < 0.0025;
        const zoomSettled =
            !(camera instanceof THREE.OrthographicCamera) || Math.abs(camera.zoom - targetZoom.current) < 0.05;
        if (positionSettled && targetSettled && zoomSettled) {
            // Snap exactly: near-vertical views roll visibly from even a tiny
            // residual horizontal offset, so finish the move rather than abandon it.
            camera.position.copy(targetPosition.current);
            currentTarget.current.copy(targetLookAt.current);
            camera.quaternion.copy(targetQuaternion.current);
            if (controls?.target) controls.target.copy(currentTarget.current);
            controls?.update?.();
            if (camera instanceof THREE.OrthographicCamera) {
                camera.zoom = targetZoom.current;
                camera.updateProjectionMatrix();
            }
            fitting.current = false;
        }
    });

    return null;
}

/**
 * Renders every district's ground plot: a tinted floor plane, an outline, and
 * a two-column sign (N-code plus label), with active/dimmed emphasis.
 *
 * @param props - `layout` supplies the neighbourhoods and their bounds;
 *   `selectedId` marks the district containing the selection as active;
 *   `activeNeighborhoodId` is the explicitly explored district, dimming the
 *   rest; `hideLabels` suppresses the signs (used while an interior is open).
 * @returns One group per visible district; implicit groups render nothing.
 */
function NeighborhoodPlots({
    layout,
    selectedId,
    activeNeighborhoodId,
    hideLabels = false,
}: {
    layout: FlowLayout;
    selectedId: string;
    activeNeighborhoodId: string | null;
    hideLabels?: boolean;
}) {
    const colors = palette.NEIGHBORHOOD_PLOT_FILLS;

    return layout.neighborhoods.map((neighborhood, index) => {
        // Local change: implicit groups (satellites of a district, the System
        // fallback) are placement-only — no plot, no label; their nodes float.
        if (neighborhood.id.startsWith("__")) return null;
        const { minX, maxX, minZ, maxZ } = neighborhood.bounds;
        const width = maxX - minX;
        const depth = maxZ - minZ;
        const centerX = (minX + maxX) / 2;
        const centerZ = (minZ + maxZ) / 2;
        const active =
            neighborhood.id === activeNeighborhoodId ||
            (!activeNeighborhoodId && neighborhood.nodeIds.includes(selectedId));
        const dimmed = !!activeNeighborhoodId && neighborhood.id !== activeNeighborhoodId;
        // Narrow districts keep a readable sign: never below 2.2 wide, and the
        // label font shrinks to fit at most two wrapped lines.
        const signWidth = Math.min(Math.max(width - 0.3, 2.2), 5.4);
        const signHeight = 0.78;
        const signZ = maxZ - signHeight / 2 - 0.28;
        const codeColumnWidth = signWidth < 3 ? 0.5 : 0.7;
        const labelAvailable = signWidth - codeColumnWidth - 0.32;
        const labelFontSize = Math.min(
            0.27,
            Math.max(0.14, (labelAvailable * 2) / (Math.max(1, neighborhood.label.length) * 0.62)),
        );
        const dividerX = -signWidth / 2 + codeColumnWidth;
        const outline: [number, number, number][] = [
            [minX, 0.004, minZ],
            [maxX, 0.004, minZ],
            [maxX, 0.004, maxZ],
            [minX, 0.004, maxZ],
            [minX, 0.004, minZ],
        ];

        return (
            <group key={neighborhood.id}>
                <mesh position={[centerX, -0.027, centerZ]} rotation={[-Math.PI / 2, 0, 0]}>
                    <planeGeometry args={[width, depth]} />
                    <meshBasicMaterial
                        color={neighborhood.color ?? colors[index % colors.length] ?? SCENE_INK}
                        transparent
                        opacity={dimmed ? 0.1 : active ? 0.5 : 0.34}
                        depthWrite={false}
                    />
                </mesh>
                <Line
                    points={outline}
                    color={active ? SCENE_INK : palette.MARKER_MUTED}
                    lineWidth={active ? 1.55 : 0.9}
                    transparent
                    opacity={dimmed ? 0.16 : active ? 0.9 : 0.62}
                />
                {!hideLabels && (
                    <group position={[centerX, 0.048, signZ]} rotation={[-Math.PI / 2, 0, 0]}>
                        <mesh>
                            <planeGeometry args={[signWidth, signHeight]} />
                            <meshBasicMaterial
                                color={active ? SCENE_INK : SCENE_PANEL}
                                transparent
                                opacity={dimmed ? 0.24 : 0.98}
                            />
                        </mesh>
                        <Line
                            points={[
                                [-signWidth / 2, -signHeight / 2, 0.008],
                                [signWidth / 2, -signHeight / 2, 0.008],
                                [signWidth / 2, signHeight / 2, 0.008],
                                [-signWidth / 2, signHeight / 2, 0.008],
                                [-signWidth / 2, -signHeight / 2, 0.008],
                            ]}
                            color={SCENE_INK}
                            lineWidth={active ? 1.35 : 0.8}
                            transparent
                            opacity={dimmed ? 0.18 : 1}
                        />
                        <Line
                            points={[
                                [dividerX, -signHeight / 2 + 0.08, 0.01],
                                [dividerX, signHeight / 2 - 0.08, 0.01],
                            ]}
                            color={active ? SCENE_PANEL : SCENE_INK}
                            lineWidth={0.75}
                            transparent
                            opacity={dimmed ? 0.14 : 0.62}
                        />
                        <Text
                            position={[-signWidth / 2 + codeColumnWidth / 2, 0, 0.014]}
                            color={active ? SCENE_PANEL : SCENE_INK}
                            fontSize={0.24}
                            anchorX="center"
                            anchorY="middle"
                            fillOpacity={dimmed ? 0.2 : 1}
                        >
                            {`N${index + 1}`}
                        </Text>
                        <Text
                            position={[dividerX + 0.18, 0, 0.014]}
                            color={active ? SCENE_PANEL : SCENE_INK}
                            fontSize={labelFontSize}
                            maxWidth={labelAvailable}
                            lineHeight={1.02}
                            textAlign="center"
                            anchorX="left"
                            anchorY="middle"
                            fillOpacity={dimmed ? 0.2 : 1}
                        >
                            {neighborhood.label}
                        </Text>
                    </group>
                )}
            </group>
        );
    });
}

/**
 * Draws the edge lines on the ground plane with directional arrowheads,
 * emphasising the active edge, focus-mode edges, and everything touching the
 * selected node (imports draw thick blue, dashed when incoming).
 *
 * @param props - `edges` and `positions` define what to draw and where;
 *   `activeEdgeId` is the single emphasised edge; `focusedEdgeIds` dims all
 *   others when focus mode is on; `routes` supplies obstacle-avoiding paths
 *   (a plain Manhattan path is used otherwise); `selectedId` triggers the
 *   touching-edge and import highlighting.
 * @returns One line-and-arrow group per drawable edge.
 */
function Connections({
    edges,
    positions,
    activeEdgeId,
    focusedEdgeIds,
    routes,
    selectedId,
    ink,
}: {
    edges: CityEdge[];
    positions: Map<string, [number, number]>;
    activeEdgeId: string | null;
    focusedEdgeIds?: Set<string> | undefined;
    routes?: Map<string, Array<[number, number]>> | undefined;
    selectedId?: string | undefined;
    ink: string;
}) {
    return edges.map((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const emphasized = edge.id === activeEdgeId;
        // Local change: selecting a structure highlights every edge touching it —
        // buildings with rooms can never reach the connections view (double-click
        // opens the interior), so selection is their only path to seeing edges.
        const touchesSelected = !!selectedId && (edge.from === selectedId || edge.to === selectedId);
        const focused = (focusedEdgeIds?.has(edge.id) ?? false) || touchesSelected;
        // Local change: dependency edges are structural plumbing, not flow — draw
        // them only when selected or in focus mode, so resting lines are data flow.
        if (edge.kind === "depends_on" && !emphasized && !focused) return null;
        // Local change: routed paths (around buildings and district plots) when
        // available; the plain 3-segment Manhattan path otherwise.
        const route = routes?.get(edge.id);
        const middleZ = from[1] + (to[1] - from[1]) * 0.52;
        const points: [number, number, number][] =
            route && route.length >= 2
                ? route.map(([x, z]) => [x, 0.045, z])
                : [
                      [from[0], 0.045, from[1]],
                      [from[0], 0.045, middleZ],
                      [to[0], 0.045, middleZ],
                      [to[0], 0.045, to[1]],
                  ];
        const last = points[points.length - 1];
        const beforeLast = points[points.length - 2];
        if (last === undefined || beforeLast === undefined) return null;
        const arrowStart = new THREE.Vector3(beforeLast[0], 0.07, beforeLast[2]);
        const arrowEnd = new THREE.Vector3(last[0], 0.07, last[2]);
        const thirdFromEnd = points[points.length - 3];
        if (arrowStart.distanceTo(arrowEnd) < 0.12 && thirdFromEnd !== undefined)
            arrowStart.set(thirdFromEnd[0], 0.07, thirdFromEnd[2]);
        const direction = arrowEnd.clone().sub(arrowStart).normalize();
        const arrowPosition = arrowStart.clone().lerp(arrowEnd, 0.74);
        const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

        // Local change: import edges of the selected node draw thick blue —
        // solid for what it imports, dashed for what imports it. They only
        // appear on selection and must read instantly.
        const selectedImport = touchesSelected && edge.kind === "depends_on";
        const importedBy = selectedImport && edge.to === selectedId;
        const edgeColor = selectedImport ? IMPORTS_OUT_COLOR : evidenceColors(ink)[edge.evidence];
        return (
            <group key={edge.id}>
                <Line
                    points={points}
                    color={edgeColor}
                    lineWidth={selectedImport ? 3.4 : emphasized ? 3.2 : touchesSelected ? 2.8 : focused ? 1.4 : 1.3}
                    dashed={importedBy}
                    dashSize={0.45}
                    gapSize={0.28}
                    transparent
                    opacity={
                        selectedImport
                            ? 1
                            : emphasized
                              ? 1
                              : touchesSelected
                                ? 0.95
                                : focused
                                  ? 0.55
                                  : focusedEdgeIds
                                    ? 0.03
                                    : 0.62
                    }
                />
                <mesh position={arrowPosition} quaternion={quaternion}>
                    <coneGeometry
                        args={[
                            selectedImport ? 0.12 : emphasized ? 0.11 : touchesSelected ? 0.1 : 0.08,
                            selectedImport ? 0.3 : emphasized ? 0.27 : touchesSelected ? 0.25 : 0.2,
                            4,
                        ]}
                    />
                    <meshBasicMaterial
                        color={edgeColor}
                        transparent
                        opacity={
                            selectedImport
                                ? 1
                                : emphasized
                                  ? 1
                                  : touchesSelected
                                    ? 0.95
                                    : focused
                                      ? 0.65
                                      : focusedEdgeIds
                                        ? 0.03
                                        : 0.65
                        }
                    />
                </mesh>
            </group>
        );
    });
}

// Only the non-box archetypes remain here; box-family shapes (buildings,
// ziggurats, archways, clock towers) are built as stacked segments inside
// Structure so coverage-fill can split them.
/**
 * Builds the base geometry for the non-box archetypes: a cylinder for
 * databases, a dodecahedron for clouds, a plain box for anything else.
 *
 * @param archetype - The node archetype choosing the shape.
 * @param width - Structure width in world units.
 * @param height - Structure height in world units.
 * @param depth - Structure depth in world units.
 * @returns A fresh three.js geometry for the structure body.
 */
function geometryFor(archetype: CityNode["archetype"], width: number, height: number, depth: number) {
    if (archetype === "database") return new THREE.CylinderGeometry(width / 2, width / 2, height, 24);
    if (archetype === "cloud") return new THREE.DodecahedronGeometry(width * 0.57, 0);
    return new THREE.BoxGeometry(width, height, depth);
}

/**
 * Translates a node's kind and archetype into the plain-English type label
 * shown in the rail, hover card, and inspector.
 *
 * @param node - The node being described.
 * @param roomCount - How many child rooms it contains; systems with rooms get
 *   a room-count label regardless of archetype.
 * @returns The label text, or an empty string for plain workers.
 */
function plainType(node: CityNode, roomCount: number) {
    if (roomCount > 0) return `System with ${roomCount} room${roomCount === 1 ? "" : "s"}`;
    if (node.archetype === "room") return "Room";
    if (node.archetype === "gateway") return "Entry point";
    // Workers are the bulk of the map; an unlabelled type reads cleaner than
    // "Background process" on every plain module.
    if (node.archetype === "worker") return "";
    if (node.archetype === "database") return "Data store";
    if (node.archetype === "queue") return "Event channel";
    if (node.archetype === "storage") return "Storage";
    if (node.kind === "external" || node.archetype === "cloud") return "External service";
    if (node.kind === "infra") return "Infrastructure";
    return "Internal component";
}

/**
 * Turns a source reference into a clickable URL: an explicit url wins, then a
 * GitHub blob link (with line anchor) built from the map's repository, or a
 * GitHub code search when the path contains glob characters.
 *
 * @param map - The map whose repository field anchors relative paths.
 * @param source - The reference to link.
 * @returns The href, or null when no link can be constructed.
 */
function sourceHref(map: CityMap, source: SourceRef) {
    if (source.url) return source.url;
    if (!source.path || !map.repository) return null;
    const repository = map.repository
        .replace(/^https?:\/\//, "")
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
    if (!repository.startsWith("github.com/")) return null;
    if (/[*?]/.test(source.path)) {
        return `https://${repository}/search?q=${encodeURIComponent(`path:${source.path}`)}&type=code`;
    }
    const path = source.path.replace(/^\.\//, "").split("/").map(encodeURIComponent).join("/");
    return `https://${repository}/blob/HEAD/${path}${source.line ? `#L${source.line}` : ""}`;
}

/**
 * Walks up the parent chain until it finds a node that is visible in the
 * current view, so edges between hidden rooms can be projected onto their
 * campus-level buildings.
 *
 * @param nodeId - The node to start from.
 * @param nodeById - Lookup of every node in the map.
 * @param visibleIds - The ids currently rendered.
 * @returns The nearest visible ancestor's id (possibly the node itself), or
 *   null when the whole chain is hidden.
 */
function closestVisibleAncestor(nodeId: string, nodeById: Map<string, CityNode>, visibleIds: Set<string>) {
    let current = nodeById.get(nodeId);
    while (current) {
        if (visibleIds.has(current.id)) return current.id;
        current = current.parentId ? nodeById.get(current.parentId) : undefined;
    }
    return null;
}

type BoxSegment = { x?: number; z?: number; w: number; d: number; y0: number; y1: number };

/**
 * Builds the box geometry for one stacked segment of a structure, translated
 * into its place within the stack.
 *
 * @param segment - The segment's footprint, optional x/z offset, and vertical extent.
 * @returns A positioned box geometry ready to merge with its siblings.
 */
function segmentGeometry(segment: BoxSegment) {
    const box = new THREE.BoxGeometry(segment.w, segment.y1 - segment.y0, segment.d);
    box.translate(segment.x ?? 0, (segment.y0 + segment.y1) / 2, segment.z ?? 0);
    return box;
}

/**
 * Renders one node's 3D body: the archetype-specific shape (box, ziggurat,
 * archway, clock tower, cylinder, dodecahedron), the coverage-gap split,
 * outline, floor lines, and hover/selection emphasis, animated via damped
 * scale and opacity.
 *
 * @param props - `node` supplies size, colour, tags, and metrics; `position`
 *   is the ground-plane [x, z]; `selected` drives emphasis; `hasInterior`
 *   marks buildings with rooms; `expanded` flattens the shell while its
 *   interior is open; `interior` renders it as a room inside a building;
 *   `dimmed` fades it during focus/neighbourhood modes; `onSelect`/`onEnter`
 *   fire on click and double-click.
 * @returns The structure's mesh group (empty while expanded).
 */
function Structure({
    node,
    position,
    selected,
    hasInterior,
    expanded = false,
    interior = false,
    dimmed = false,
    onSelect,
    onEnter,
}: {
    node: CityNode;
    position: [number, number];
    selected: boolean;
    hasInterior: boolean;
    expanded?: boolean;
    interior?: boolean;
    dimmed?: boolean;
    onSelect: () => void;
    onEnter: () => void;
}) {
    const [hovered, setHovered] = useState(false);
    const group = useRef<THREE.Group>(null);
    const material = useRef<THREE.MeshStandardMaterial>(null);
    const declaredSize = node.display?.size ?? [1.65, 1.2, 1.4];
    // Local change: campus structures render at 80% so tightly packed rows do
    // not obscure the nameplates in front of the row behind.
    const structureScale = interior ? 1 : 0.8;
    const requestedSize = declaredSize.map((d) => d * structureScale) as [number, number, number];
    const size: [number, number, number] =
        node.archetype === "building" && !hasInterior
            ? [requestedSize[0], Math.min(requestedSize[1], 1.25), requestedSize[2]]
            : requestedSize;
    const [width, height, depth] = size;
    const visualArchetype = node.archetype === "building" && !hasInterior ? "room" : node.archetype;
    // Local change: support modules (overview mode) render as four-sided
    // ziggurats so they read differently from the composer buildings.
    const isSupportShape = node.archetype === "worker" && (node.tags ?? []).includes("support");
    // Local change: cron-tagged structures render as clock towers (a narrow
    // tower with a pyramidal cap and a clockface near the top).
    const isCronShape =
        !isSupportShape &&
        !interior &&
        (node.tags ?? []).includes("cron") &&
        visualArchetype !== "database" &&
        visualArchetype !== "cloud" &&
        visualArchetype !== "gateway";
    // Local change: box-family shapes (plain buildings, ziggurats, archways,
    // clock towers) are built as stacked box segments. Coverage-fill splits the
    // stack at the covered height — covered segments in the node colour, the
    // remainder as red gap segments. Stacking (never overlaying) avoids
    // coplanar faces and z-fighting.
    const segments = useMemo<BoxSegment[] | null>(() => {
        if (visualArchetype === "database" || visualArchetype === "cloud") return null;
        if (isSupportShape) {
            // Ziggurat: at least 3 tiers (short ones get slim layers); a layer is
            // added whenever the tier height would exceed the threshold, so slabs
            // never thicken as the building grows. Step-down adapts to tier count.
            const MAX_TIER_HEIGHT = 0.5;
            const tierCount = Math.max(3, Math.ceil(height / MAX_TIER_HEIGHT));
            const topScale = 0.42;
            return Array.from({ length: tierCount }, (_, tier) => {
                const scale = 1 - (1 - topScale) * (tier / (tierCount - 1));
                return {
                    w: width * scale,
                    d: depth * scale,
                    y0: -height / 2 + (tier * height) / tierCount,
                    y1: -height / 2 + ((tier + 1) * height) / tierCount,
                };
            });
        }
        if (visualArchetype === "gateway") {
            // Archway: pillars carry the height at constant thickness; the lintel
            // is a constant-thickness slab.
            const pillarWidth = Math.min(width * 0.32, 0.5);
            const lintelHeight = Math.min(height * 0.4, 0.45);
            const archDepth = depth * 0.72;
            return [
                {
                    x: -(width - pillarWidth) / 2,
                    w: pillarWidth,
                    d: archDepth,
                    y0: -height / 2,
                    y1: height / 2 - lintelHeight,
                },
                {
                    x: (width - pillarWidth) / 2,
                    w: pillarWidth,
                    d: archDepth,
                    y0: -height / 2,
                    y1: height / 2 - lintelHeight,
                },
                { w: width, d: archDepth, y0: height / 2 - lintelHeight, y1: height / 2 },
            ];
        }
        if (isCronShape) {
            return [{ w: width * 0.58, d: depth * 0.58, y0: -height / 2, y1: height / 2 - height * 0.15 }];
        }
        return [{ w: width, d: depth, y0: -height / 2, y1: height / 2 }];
    }, [depth, height, isCronShape, isSupportShape, visualArchetype, width]);
    const cronCap = useMemo(() => {
        if (!isCronShape) return null;
        const cap = new THREE.ConeGeometry(width * 0.58 * 0.72, height * 0.15, 4);
        cap.rotateY(Math.PI / 4);
        cap.translate(0, height / 2 - height * 0.075, 0);
        return cap;
    }, [height, isCronShape, width]);
    const { coverage: coverageMetric } = (node.metrics ?? {}) as Record<string, number>;
    const coveragePct = typeof coverageMetric === "number" ? coverageMetric : null;
    const coverageFraction =
        coveragePct !== null && segments !== null && !interior && !expanded
            ? Math.max(0.04, Math.min(1, coveragePct / 100))
            : null;
    const hasCoverageGap = coverageFraction !== null && coverageFraction < 0.995;
    const [geometry, gapGeometry, fullGeometry] = useMemo(() => {
        if (!segments) {
            const shape = geometryFor(visualArchetype, width, height, depth);
            return [shape, null, shape] as const;
        }
        const all = [...segments.map(segmentGeometry), ...(cronCap ? [cronCap.clone()] : [])];
        const full = mergeGeometries(all);
        if (!hasCoverageGap || coverageFraction === null) return [full, null, full] as const;
        const cutY = -height / 2 + height * coverageFraction;
        const covered: THREE.BufferGeometry[] = [];
        const gap: THREE.BufferGeometry[] = [];
        for (const segment of segments) {
            if (segment.y1 <= cutY) covered.push(segmentGeometry(segment));
            else if (segment.y0 >= cutY) gap.push(segmentGeometry(segment));
            else {
                covered.push(segmentGeometry({ ...segment, y1: cutY }));
                gap.push(segmentGeometry({ ...segment, y0: cutY }));
            }
        }
        // The tower cap is indivisible: red unless the cut clears its base.
        if (cronCap) (cutY >= height / 2 - height * 0.15 ? covered : gap).push(cronCap.clone());
        return [
            covered.length ? mergeGeometries(covered) : new THREE.BufferGeometry(),
            gap.length ? mergeGeometries(gap) : null,
            full,
        ] as const;
    }, [segments, cronCap, hasCoverageGap, coverageFraction, depth, height, visualArchetype, width]);
    const outline = useMemo(() => new THREE.EdgesGeometry(fullGeometry), [fullGeometry]);
    const color =
        node.display?.color ??
        (node.kind === "infra"
            ? palette.STRUCTURE_INFRA
            : node.kind === "external"
              ? palette.STRUCTURE_EXTERNAL
              : palette.STRUCTURE_DEFAULT);
    const floorCount = hasInterior ? Math.max(0, Math.min(4, Math.round(height * 1.2) - 1)) : 0;
    const worldScale = interior ? 0.48 : 1;
    const initialScale = interior ? 0.08 : 1;

    useFrame((_, delta) => {
        if (group.current) {
            const targetXz = expanded ? 1.08 : worldScale;
            const targetY = expanded ? 0.12 : worldScale;
            group.current.scale.x = THREE.MathUtils.damp(group.current.scale.x, targetXz, 7.5, delta);
            group.current.scale.y = THREE.MathUtils.damp(group.current.scale.y, targetY, 7.5, delta);
            group.current.scale.z = THREE.MathUtils.damp(group.current.scale.z, targetXz, 7.5, delta);
            group.current.position.y = THREE.MathUtils.damp(
                group.current.position.y,
                (height * targetY) / 2,
                7.5,
                delta,
            );
        }
        if (material.current) {
            const targetOpacity = dimmed ? 0.22 : expanded ? 0.28 : node.kind === "external" ? 0.82 : 1;
            material.current.opacity = THREE.MathUtils.damp(material.current.opacity, targetOpacity, 7.5, delta);
        }
    });

    // Spread as a bundle so both segment meshes share the exact same handlers.
    const meshInteractions = {
        onClick: (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            onSelect();
        },
        onDoubleClick: (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            if (!interior || hasInterior) onEnter();
        },
        onPointerEnter: () => {
            setHovered(true);
            document.body.style.cursor = "pointer";
        },
        onPointerLeave: () => {
            setHovered(false);
            document.body.style.cursor = "default";
        },
    };

    return (
        <group
            ref={group}
            position={[position[0], (height * initialScale) / 2, position[1]]}
            scale={[initialScale, initialScale, initialScale]}
        >
            {!expanded && (
                <>
                    <mesh
                        geometry={geometry}
                        castShadow
                        receiveShadow
                        {...meshInteractions}
                        scale={selected ? 1.075 : 1}
                    >
                        <meshStandardMaterial
                            ref={material}
                            color={color}
                            roughness={0.86}
                            transparent
                            opacity={interior ? 0 : node.kind === "external" ? 0.82 : 1}
                            emissive={selected || hovered ? color : "#000000"}
                            emissiveIntensity={selected ? 0.32 : hovered ? 0.1 : 0}
                        />
                    </mesh>
                    {gapGeometry && (
                        <mesh geometry={gapGeometry} castShadow {...meshInteractions} scale={selected ? 1.075 : 1}>
                            <meshStandardMaterial
                                color={palette.COVERAGE_GAP}
                                roughness={0.86}
                                emissive={selected || hovered ? palette.COVERAGE_GAP : "#000000"}
                                emissiveIntensity={selected ? 0.32 : hovered ? 0.1 : 0}
                            />
                        </mesh>
                    )}
                    {/* Decorations must not raycast: the line threshold is a full world
            unit, which bleeds the hover zone far outside the building. */}
                    <lineSegments geometry={outline} scale={selected ? 1.06 : 1.006} raycast={() => null}>
                        <lineBasicMaterial color={SCENE_INK} transparent opacity={dimmed ? 0.2 : 1} />
                    </lineSegments>
                    {isCronShape &&
                        (() => {
                            const clockRadius = Math.min(width, depth) * 0.19;
                            const clockY = height * 0.2;
                            const clockZ = depth * 0.29 + 0.012;
                            return (
                                <group position={[0, clockY, clockZ]}>
                                    <mesh>
                                        <circleGeometry args={[clockRadius, 20]} />
                                        <meshBasicMaterial color={SCENE_PANEL} />
                                    </mesh>
                                    <mesh position={[0, 0, 0.002]}>
                                        <ringGeometry args={[clockRadius * 0.86, clockRadius, 20]} />
                                        <meshBasicMaterial color={SCENE_INK} />
                                    </mesh>
                                    <mesh position={[0, clockRadius * 0.32, 0.002]}>
                                        <planeGeometry args={[clockRadius * 0.14, clockRadius * 0.64]} />
                                        <meshBasicMaterial color={SCENE_INK} />
                                    </mesh>
                                    <mesh position={[clockRadius * 0.22, 0, 0.002]} rotation={[0, 0, -Math.PI / 2]}>
                                        <planeGeometry args={[clockRadius * 0.14, clockRadius * 0.44]} />
                                        <meshBasicMaterial color={SCENE_INK} />
                                    </mesh>
                                </group>
                            );
                        })()}
                    {node.archetype !== "database" &&
                        node.archetype !== "cloud" &&
                        node.archetype !== "gateway" &&
                        !isCronShape &&
                        Array.from(
                            { length: floorCount },
                            (_, floor) => -height / 2 + ((floor + 1) * height) / (floorCount + 1),
                        ).map((floorY) => (
                            <mesh key={floorY} position={[0, floorY, depth / 2 + 0.008]}>
                                <planeGeometry args={[width * 0.86, 0.018]} />
                                <meshBasicMaterial color={SCENE_INK} transparent opacity={dimmed ? 0.12 : 0.56} />
                            </mesh>
                        ))}
                </>
            )}
        </group>
    );
}

/**
 * Renders a node's flat map furniture: the footprint outline on the ground, a
 * leader line, and the nameplate plaque (index code plus label) in front of
 * the structure, all clickable like the structure itself.
 *
 * @param props - `node` supplies label, kind, and size; `index` becomes the
 *   marker code (zero-padded number, or R-prefixed for rooms); `position` is
 *   the ground-plane [x, z]; `selected`/`expanded`/`exploring` switch the
 *   plaque to its active style; `hasInterior` widens landmark plaques and
 *   enables the open affordance; `interior` styles it as a room marker;
 *   `dimmed` fades it; `onSelect`/`onEnter` fire on click and double-click.
 * @returns The marker group with footprint, leader line, and plaque.
 */
function MapMarker({
    node,
    index,
    position,
    selected,
    hasInterior,
    expanded = false,
    exploring = false,
    interior = false,
    dimmed = false,
    onSelect,
    onEnter,
}: {
    node: CityNode;
    index: number;
    position: [number, number];
    selected: boolean;
    hasInterior: boolean;
    expanded?: boolean;
    exploring?: boolean;
    interior?: boolean;
    dimmed?: boolean;
    onSelect: () => void;
    onEnter: () => void;
}) {
    const requestedSize = node.display?.size ?? [1.65, 1.2, 1.4];
    // 0.8 matches Structure's campus structureScale so footprints stay snug.
    const scale = interior ? 0.48 : (expanded ? 1.08 : 1) * 0.8;
    const footprintWidth = requestedSize[0] * scale + (interior ? 0.14 : 0.24);
    const footprintDepth = requestedSize[2] * scale + (interior ? 0.14 : 0.24);
    const labelLength = node.label.length + (hasInterior ? 3 : 0);
    const landmark = hasInterior && !interior;
    const quieter = node.kind === "external" && !interior;
    // Local change: campus nameplates shrink to a fraction of upstream size so
    // buildings can pack tightly; they stay on the floor in front of the building.
    const labelScale = interior ? 1 : 0.4;
    const plaqueWidth =
        (interior
            ? Math.max(1.5, Math.min(2.4, 1.08 + labelLength * 0.045))
            : landmark
              ? Math.max(3.15, Math.min(4.7, 2.1 + labelLength * 0.065))
              : quieter
                ? Math.max(2.35, Math.min(3.65, 1.75 + labelLength * 0.05))
                : Math.max(2.6, Math.min(4.1, 1.9 + labelLength * 0.058))) * labelScale;
    const plaqueHeight = (interior ? 0.58 : landmark ? 1.02 : quieter ? 0.76 : 0.88) * labelScale;
    const codeFontSize = (interior ? 0.13 : landmark ? 0.2 : quieter ? 0.145 : 0.17) * labelScale;
    const labelFontSize = (interior ? 0.17 : landmark ? 0.29 : quieter ? 0.205 : 0.24) * labelScale;
    const plaqueColor =
        node.kind === "external"
            ? palette.PLAQUE_EXTERNAL
            : node.kind === "infra"
              ? palette.PLAQUE_INFRA
              : palette.PLAQUE_DEFAULT;
    const markerY = 0.055;
    const plaqueZ = position[1] + footprintDepth / 2 + plaqueHeight / 2 + (interior ? 0.12 : 0.06);
    const plaqueNearEdgeZ = plaqueZ - plaqueHeight / 2;
    const footprint: [number, number, number][] = [
        [position[0] - footprintWidth / 2, markerY, position[1] - footprintDepth / 2],
        [position[0] + footprintWidth / 2, markerY, position[1] - footprintDepth / 2],
        [position[0] + footprintWidth / 2, markerY, position[1] + footprintDepth / 2],
        [position[0] - footprintWidth / 2, markerY, position[1] + footprintDepth / 2],
        [position[0] - footprintWidth / 2, markerY, position[1] - footprintDepth / 2],
    ];
    const plaqueOutline: [number, number, number][] = [
        [-plaqueWidth / 2, -plaqueHeight / 2, 0.008],
        [plaqueWidth / 2, -plaqueHeight / 2, 0.008],
        [plaqueWidth / 2, plaqueHeight / 2, 0.008],
        [-plaqueWidth / 2, plaqueHeight / 2, 0.008],
        [-plaqueWidth / 2, -plaqueHeight / 2, 0.008],
    ];
    const canEnter = !interior || hasInterior;
    const active = selected || expanded || exploring;
    const markerCode = interior ? `R${index + 1}` : String(index + 1).padStart(2, "0");
    const labelText = `${node.label}${canEnter ? `  ${expanded || exploring ? "×" : "↘"}` : ""}`;
    const codeColumnWidth = (interior ? 0.28 : 0.34) * labelScale;
    const dividerX = -plaqueWidth / 2 + codeColumnWidth;

    // Spread as a bundle to keep the group's interaction wiring in one place.
    const markerInteractions = {
        onClick: (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            onSelect();
        },
        onDoubleClick: (event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            if (canEnter) onEnter();
        },
        onPointerEnter: () => {
            document.body.style.cursor = "pointer";
        },
        onPointerLeave: () => {
            document.body.style.cursor = "default";
        },
    };

    return (
        <group {...markerInteractions}>
            <mesh position={[position[0], markerY + 0.004, position[1]]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[footprintWidth, footprintDepth]} />
                <meshBasicMaterial
                    color={SCENE_INK}
                    transparent
                    opacity={active && !dimmed ? 0.12 : 0}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                />
            </mesh>
            <Line
                raycast={() => null}
                points={footprint}
                color={active ? SCENE_INK : interior ? palette.MARKER_INTERIOR : palette.MARKER_MUTED}
                lineWidth={active ? 1.5 : 0.8}
                dashed={interior}
                dashSize={0.09}
                gapSize={0.06}
                transparent
                opacity={dimmed ? 0.18 : 0.78}
            />
            <Line
                raycast={() => null}
                points={[
                    [position[0], markerY, position[1] + footprintDepth / 2],
                    [position[0], markerY, plaqueNearEdgeZ],
                ]}
                color={SCENE_INK}
                lineWidth={0.8}
                transparent
                opacity={dimmed ? 0.14 : 0.56}
            />
            <group position={[position[0], markerY + 0.012, plaqueZ]} rotation={[-Math.PI / 2, 0, 0]}>
                <mesh>
                    <planeGeometry args={[plaqueWidth, plaqueHeight]} />
                    <meshBasicMaterial
                        color={active ? SCENE_INK : plaqueColor}
                        transparent
                        opacity={dimmed ? 0.3 : quieter ? 0.9 : 0.98}
                    />
                </mesh>
                <Line
                    raycast={() => null}
                    points={plaqueOutline}
                    color={SCENE_INK}
                    lineWidth={active ? 1.4 : 0.85}
                    transparent
                    opacity={dimmed ? 0.18 : 0.9}
                />
                <Line
                    raycast={() => null}
                    points={[
                        [dividerX, -plaqueHeight / 2 + 0.07 * labelScale, 0.01],
                        [dividerX, plaqueHeight / 2 - 0.07 * labelScale, 0.01],
                    ]}
                    color={active ? SCENE_PANEL : SCENE_INK}
                    lineWidth={0.65}
                    transparent
                    opacity={dimmed ? 0.18 : 0.48}
                />
                <Text
                    position={[-plaqueWidth / 2 + codeColumnWidth / 2, 0, 0.014]}
                    color={active ? SCENE_PANEL : SCENE_INK}
                    fontSize={codeFontSize}
                    anchorX="center"
                    anchorY="middle"
                    fillOpacity={dimmed ? 0.34 : 0.72}
                >
                    {markerCode}
                </Text>
                <Text
                    position={[dividerX + 0.1 * labelScale, 0, 0.014]}
                    color={active ? SCENE_PANEL : SCENE_INK}
                    fontSize={labelFontSize}
                    maxWidth={plaqueWidth - codeColumnWidth - 0.2 * labelScale}
                    lineHeight={1.04}
                    textAlign="left"
                    anchorX="left"
                    anchorY="middle"
                    fillOpacity={dimmed ? 0.34 : 1}
                >
                    {labelText}
                </Text>
            </group>
        </group>
    );
}

/**
 * Renders the pale floor slab and dashed outline underneath an opened
 * building's rooms.
 *
 * @param props - `bounds` is the interior layout's bounding box.
 * @returns The interior plot's plane and outline.
 */
function InteriorPlot({ bounds }: { bounds: FlowLayout["bounds"] }) {
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxZ - bounds.minZ;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerZ = (bounds.minZ + bounds.maxZ) / 2;
    const outline: [number, number, number][] = [
        [bounds.minX, 0.025, bounds.minZ],
        [bounds.maxX, 0.025, bounds.minZ],
        [bounds.maxX, 0.025, bounds.maxZ],
        [bounds.minX, 0.025, bounds.maxZ],
        [bounds.minX, 0.025, bounds.minZ],
    ];

    return (
        <group>
            <mesh position={[centerX, 0.012, centerZ]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[width, depth]} />
                <meshBasicMaterial color={SCENE_PANEL} transparent opacity={0.88} depthWrite={false} />
            </mesh>
            <Line points={outline} color={SCENE_INK} lineWidth={1.1} dashed dashSize={0.14} gapSize={0.09} />
        </group>
    );
}

/**
 * The react-three-fiber canvas: computes the layout and edge routes, derives
 * the interior/focus/neighbourhood view models, and composes the camera rig,
 * lights, plots, connections, structures, markers, and map controls.
 *
 * @param props - `nodes`/`edges` are the campus-level view; `allNodes`/
 *   `allEdges` the whole map (for interiors); `selectedId`, `activeEdgeId`,
 *   `interiorActiveEdgeId`, `expandedId`, `focusId`, and `neighborhoodId`
 *   describe the current selection and view mode; `onSelect`, `onEnter`,
 *   `onHover`, and `onDeselect` report interactions upward; `viewKey` and
 *   `overheadView` steer the camera rig.
 * @returns The full 3D scene inside its Canvas element.
 */
function CityScene({
    nodes,
    allNodes,
    edges,
    allEdges,
    selectedId,
    activeEdgeId,
    interiorActiveEdgeId,
    expandedId,
    focusId,
    neighborhoodId,
    onSelect,
    onEnter,
    onHover,
    viewKey,
    overheadView,
    onDeselect,
    background,
    ink,
}: {
    nodes: CityNode[];
    allNodes: CityNode[];
    edges: CityEdge[];
    allEdges: CityEdge[];
    selectedId: string;
    activeEdgeId: string | null;
    interiorActiveEdgeId: string | null;
    expandedId: string | null;
    focusId: string | null;
    neighborhoodId: string | null;
    onSelect: (id: string) => void;
    onEnter: (id: string) => void;
    onHover: (node: CityNode | null, x: number, y: number) => void;
    viewKey: string;
    overheadView: boolean;
    onDeselect: () => void;
    background: string;
    ink: string;
}) {
    const layout = useMemo(() => computeFlowLayout(nodes, edges, allNodes), [allNodes, edges, nodes]);
    const edgeRouter = useMemo(() => createEdgeRouter(layout, nodes), [layout, nodes]);
    // Data-flow edges route eagerly (always visible); import edges route
    // on demand below, only for the selected or focused node.
    const edgeRoutes = useMemo(() => {
        const routed = new Map<string, Array<[number, number]>>();
        for (const edge of edges) {
            if (edge.kind === "depends_on") continue;
            const route = edgeRouter.route(edge);
            if (route) routed.set(edge.id, route);
        }
        return routed;
    }, [edgeRouter, edges]);
    const interiorModel = useMemo(() => {
        if (!expandedId) return null;
        const parentPosition = layout.positions.get(expandedId);
        const parent = allNodes.find((node) => node.id === expandedId);
        const children = allNodes.filter((node) => node.parentId === expandedId);
        if (!parentPosition || !parent || !children.length) return null;

        const childIds = new Set(children.map((node) => node.id));
        const childEdges = allEdges.filter((edge) => childIds.has(edge.from) && childIds.has(edge.to));
        const childLayout = computeFlowLayout(children, childEdges, allNodes);
        const localCenterX = (childLayout.bounds.minX + childLayout.bounds.maxX) / 2;
        const localCenterZ = (childLayout.bounds.minZ + childLayout.bounds.maxZ) / 2;
        const positions = new Map<string, [number, number]>();
        const spread = 0.72;
        children.forEach((child) => {
            const local = childLayout.positions.get(child.id);
            if (local === undefined) return;
            positions.set(child.id, [
                parentPosition[0] + (local[0] - localCenterX) * spread,
                parentPosition[1] + (local[1] - localCenterZ) * spread,
            ]);
        });

        const extents = children.flatMap((child) => {
            const childPosition = positions.get(child.id);
            if (childPosition === undefined) return [];
            const [x, z] = childPosition;
            const [childWidth, , childDepth] = child.display?.size ?? [1.65, 1.2, 1.4];
            return [
                {
                    minX: x - childWidth * 0.28,
                    maxX: x + childWidth * 0.28,
                    minZ: z - childDepth * 0.28,
                    maxZ: z + childDepth * 0.28,
                },
            ];
        });
        const plotBounds = {
            minX: Math.min(...extents.map((extent) => extent.minX)) - 0.65,
            maxX: Math.max(...extents.map((extent) => extent.maxX)) + 0.65,
            minZ: Math.min(...extents.map((extent) => extent.minZ)) - 0.65,
            maxZ: Math.max(...extents.map((extent) => extent.maxZ)) + 0.65,
        };
        const cameraBounds = {
            minX: Math.min(parentPosition[0] - 4.2, plotBounds.minX - 0.8),
            maxX: Math.max(parentPosition[0] + 4.2, plotBounds.maxX + 0.8),
            minZ: Math.min(parentPosition[1] - 3.6, plotBounds.minZ - 0.8),
            maxZ: Math.max(parentPosition[1] + 3.6, plotBounds.maxZ + 0.8),
        };
        return { parent, children, childEdges, positions, plotBounds, cameraBounds };
    }, [allEdges, allNodes, expandedId, layout]);
    const focusModel = useMemo(() => {
        if (!focusId || interiorModel) return null;
        const focusedEdges = edges.filter((edge) => edge.from === focusId || edge.to === focusId);
        const nodeIds = new Set([focusId]);
        focusedEdges.forEach((edge) => {
            nodeIds.add(edge.from);
            nodeIds.add(edge.to);
        });
        const extents = nodes
            .filter((node) => nodeIds.has(node.id))
            .flatMap((node) => {
                const nodePosition = layout.positions.get(node.id);
                if (nodePosition === undefined) return [];
                const [x, z] = nodePosition;
                const [width, , depth] = node.display?.size ?? [1.65, 1.2, 1.4];
                return [{ minX: x - width / 2, maxX: x + width / 2, minZ: z - depth / 2, maxZ: z + depth / 2 }];
            });
        if (!extents.length) return null;
        const bounds = {
            minX: Math.min(...extents.map((extent) => extent.minX)) - 1.5,
            maxX: Math.max(...extents.map((extent) => extent.maxX)) + 1.5,
            minZ: Math.min(...extents.map((extent) => extent.minZ)) - 1.5,
            maxZ: Math.max(...extents.map((extent) => extent.maxZ)) + 1.5,
        };
        return { nodeIds, edgeIds: new Set(focusedEdges.map((edge) => edge.id)), bounds };
    }, [edges, focusId, interiorModel, layout, nodes]);
    const neighborhoodModel = useMemo(() => {
        if (!neighborhoodId || interiorModel || focusModel) return null;
        const neighborhood = layout.neighborhoods.find((candidate) => candidate.id === neighborhoodId);
        if (!neighborhood) return null;
        return {
            nodeIds: new Set(neighborhood.nodeIds),
            bounds: { ...neighborhood.bounds, maxZ: neighborhood.bounds.maxZ + 0.9 },
        };
    }, [focusModel, interiorModel, layout, neighborhoodId]);

    // Import edges of the selected/focused node route on demand: the router
    // caches per edge, so re-selecting is instant.
    const activeRoutes = useMemo(() => {
        const wanted = edges.filter(
            (edge) =>
                edge.kind === "depends_on" &&
                ((selectedId && (edge.from === selectedId || edge.to === selectedId)) ||
                    focusModel?.edgeIds.has(edge.id)),
        );
        if (!wanted.length) return edgeRoutes;
        const routed = new Map(edgeRoutes);
        for (const edge of wanted) {
            const route = edgeRouter.route(edge);
            if (route) routed.set(edge.id, route);
        }
        return routed;
    }, [edgeRouter, edgeRoutes, edges, focusModel, selectedId]);

    return (
        <Canvas
            orthographic
            // Orthographic: distance does not affect size, so sit far out with a
            // small positive near. A negative near moves the raycaster origin into
            // the scene and makes the frontmost structures unclickable.
            camera={{ position: [120, 156, 180], zoom: 48, near: 0.1, far: 800 }}
            shadows
            dpr={[1, 1.7]}
            onPointerMissed={() => onDeselect()}
        >
            <CameraRig
                viewKey={viewKey}
                bounds={interiorModel?.cameraBounds ?? focusModel?.bounds ?? neighborhoodModel?.bounds ?? layout.bounds}
                overhead={overheadView}
            />
            <color attach="background" args={[background]} />
            <ambientLight intensity={1.6} />
            <directionalLight position={[-6, 12, 7]} intensity={2.25} castShadow shadow-mapSize={[1024, 1024]} />
            <NeighborhoodPlots
                layout={layout}
                selectedId={selectedId}
                activeNeighborhoodId={neighborhoodId}
                hideLabels={!!interiorModel}
            />
            <Connections
                edges={edges}
                positions={layout.positions}
                activeEdgeId={activeEdgeId}
                focusedEdgeIds={focusModel?.edgeIds}
                routes={activeRoutes}
                selectedId={selectedId}
                ink={ink}
            />
            {interiorModel && (
                <>
                    <InteriorPlot bounds={interiorModel.plotBounds} />
                    <Connections
                        edges={interiorModel.childEdges}
                        positions={interiorModel.positions}
                        activeEdgeId={interiorActiveEdgeId}
                        selectedId={selectedId}
                        ink={ink}
                    />
                </>
            )}
            {nodes.map((node, index) => {
                const nodePosition = layout.positions.get(node.id);
                if (nodePosition === undefined) return null;
                return (
                    <group
                        key={node.id}
                        onPointerMove={(event) => {
                            event.stopPropagation();
                            onHover(node, event.nativeEvent.clientX, event.nativeEvent.clientY);
                        }}
                        onPointerOut={() => onHover(null, 0, 0)}
                    >
                        <Structure
                            node={node}
                            position={nodePosition}
                            selected={node.id === selectedId}
                            hasInterior={allNodes.some((candidate) => candidate.parentId === node.id)}
                            expanded={node.id === expandedId}
                            dimmed={
                                interiorModel
                                    ? node.id !== expandedId
                                    : neighborhoodModel
                                      ? !neighborhoodModel.nodeIds.has(node.id)
                                      : !!focusModel && !focusModel.nodeIds.has(node.id)
                            }
                            onSelect={() => onSelect(node.id)}
                            onEnter={() => onEnter(node.id)}
                        />
                        {(!interiorModel || node.id === expandedId) && (
                            <MapMarker
                                node={node}
                                index={index}
                                position={nodePosition}
                                selected={node.id === selectedId}
                                hasInterior={allNodes.some((candidate) => candidate.parentId === node.id)}
                                expanded={node.id === expandedId}
                                exploring={node.id === focusId}
                                dimmed={
                                    neighborhoodModel
                                        ? !neighborhoodModel.nodeIds.has(node.id)
                                        : !!focusModel && !focusModel.nodeIds.has(node.id)
                                }
                                onSelect={() => onSelect(node.id)}
                                onEnter={() => onEnter(node.id)}
                            />
                        )}
                    </group>
                );
            })}
            {interiorModel?.children.map((node, index) => {
                const nodePosition = interiorModel.positions.get(node.id);
                if (nodePosition === undefined) return null;
                return (
                    <group
                        key={node.id}
                        onPointerMove={(event) => {
                            event.stopPropagation();
                            onHover(node, event.nativeEvent.clientX, event.nativeEvent.clientY);
                        }}
                        onPointerOut={() => onHover(null, 0, 0)}
                    >
                        <Structure
                            node={node}
                            position={nodePosition}
                            selected={node.id === selectedId}
                            hasInterior={allNodes.some((candidate) => candidate.parentId === node.id)}
                            interior
                            onSelect={() => onSelect(node.id)}
                            onEnter={() => onEnter(node.id)}
                        />
                        <MapMarker
                            node={node}
                            index={index}
                            position={nodePosition}
                            selected={node.id === selectedId}
                            hasInterior={allNodes.some((candidate) => candidate.parentId === node.id)}
                            interior
                            onSelect={() => onSelect(node.id)}
                            onEnter={() => onEnter(node.id)}
                        />
                    </group>
                );
            })}
            {/* Polar angle locked to the initial camera elevation: rotation orbits
          the vertical axis only, so the ground plane never tilts. */}
            <MapControls
                makeDefault
                enableRotate
                enableDamping
                dampingFactor={0.08}
                minZoom={12}
                maxZoom={110}
                screenSpacePanning
                minPolarAngle={0}
                maxPolarAngle={Math.PI / 2}
            />
        </Canvas>
    );
}

/**
 * Builds the pointer-following card's content for a hovered node: its first
 * few source paths, plus its metrics, room count, plain type, and tags.
 *
 * @param node - The hovered node.
 * @param roomCount - How many rooms the node contains.
 * @returns The paths and facts for {@link HoverDetails}.
 */
function hoverCardDetails(node: CityNode, roomCount: number): { paths: string[]; facts: HoverFact[] } {
    const paths = (node.sourceRefs ?? []).slice(0, 3).map((ref) => ref.path ?? ref.url ?? "");
    // Complexity is now the worst single function, meaningful for buildings
    // too, so nothing is suppressed.
    const facts: HoverFact[] = Object.entries(node.metrics ?? {}).map(([key, value]) => ({
        name: key,
        value: String(value),
    }));
    if (roomCount > 0) facts.push({ name: "modules", value: String(roomCount) });
    const type = plainType(node, roomCount);
    if (type) facts.push({ name: "type", value: type.toLowerCase() });
    if (node.tags?.length) facts.push({ name: "tags", value: node.tags.join(", ") });
    return { paths, facts };
}

/**
 * Builds the inspector's map-summary content: the map's name, its summary and
 * generation paragraphs, and a count of what the current view contains.
 *
 * @param map - The loaded city map.
 * @param districtCount - Number of real (non-synthetic) districts on screen.
 * @param visibleNodes - Nodes rendered by the current view.
 * @param visibleEdgeCount - Number of edges rendered by the current view.
 * @returns The map-summary content for {@link Inspector}.
 */
function mapInspectorContent(
    map: CityMap,
    districtCount: number,
    visibleNodes: readonly CityNode[],
    visibleEdgeCount: number,
): InspectorContent {
    const kindLabels: Array<[string, (node: CityNode) => boolean]> = [
        ["districts", () => false],
        ["entry points", (node) => node.archetype === "gateway"],
        ["services", (node) => node.kind === "deployable"],
        ["modules", (node) => node.kind === "module" && node.archetype !== "gateway"],
        ["data stores", (node) => node.archetype === "database" || node.archetype === "storage"],
        [
            "infrastructure",
            (node) => node.kind === "infra" && node.archetype !== "database" && node.archetype !== "storage",
        ],
        ["external systems", (node) => node.kind === "external"],
    ];
    const contents: InspectorStat[] = kindLabels
        .map(([name, test]) => ({
            name,
            count: name === "districts" ? districtCount : visibleNodes.filter(test).length,
        }))
        .filter(({ count }) => count > 0)
        .map(({ name, count }) => ({ name, value: String(count) }));
    contents.push({ name: "visible edges", value: String(visibleEdgeCount) });
    const paragraphs: string[] = [];
    if (map.summary) paragraphs.push(map.summary);
    if (map.generatedAt) paragraphs.push(`Generated ${new Date(map.generatedAt).toLocaleString()}.`);
    return { kind: "map", title: map.name, paragraphs, contents };
}

/**
 * Builds the inspector's content for one node: its plain-English type,
 * description paragraphs, source-file rows (attribute paths first), and the
 * metrics that carry a value.
 *
 * @param map - The loaded city map, used to resolve source links.
 * @param node - The node being described.
 * @param childCount - How many rooms the node contains, for the type line.
 * @returns The node content for {@link Inspector}.
 */
function nodeInspectorContent(map: CityMap, node: CityNode, childCount: number): InspectorContent {
    const attributes = (node as CityNode & { attributes?: Record<string, string> }).attributes ?? {};
    const attributePaths = new Set(Object.values(attributes));
    const sources: InspectorSource[] = Object.entries(attributes).map(([name, path]) => ({
        key: `attr-${name}`,
        label: path,
        tag: name,
        href: sourceHref(map, { path }) ?? undefined,
    }));
    (node.sourceRefs ?? [])
        .filter((ref) => !ref.path || !attributePaths.has(ref.path))
        .forEach((ref) => {
            const label = `${ref.path ?? ref.url}${ref.line ? `:${ref.line}` : ""}`;
            sources.push({ key: label, label, href: sourceHref(map, ref) ?? undefined });
        });
    const { loc, complexity, coverage } = (node.metrics ?? {}) as Record<string, number>;
    const stats: InspectorStat[] = [
        { name: "loc", value: loc !== undefined ? String(loc) : "" },
        { name: "complexity", value: complexity !== undefined ? String(complexity) : "" },
        { name: "coverage", value: coverage !== undefined ? `${coverage}%` : "" },
    ].filter((stat) => stat.value !== "");
    const paragraphs = (node.description ?? "").split("\n\n").filter((paragraph) => paragraph.trim());
    return {
        kind: "node",
        nodeId: node.id,
        title: node.label,
        typeLabel: plainType(node, childCount),
        paragraphs: paragraphs.length ? paragraphs : ["Purpose not yet mapped."],
        sources,
        stats,
    };
}

/**
 * The main viewer chrome for one loaded map: top bar (map picker, actions),
 * searchable component rail, the CityScene viewport with legend and hover
 * card, and the inspector panel. Owns all selection and view-mode state.
 *
 * @param props - `map` is the loaded city map; `slug` names the showcase it
 *   came from (null for opened files); `jsonPath` is the opened file's name;
 *   `onSelectShowcase`, `onImport`, and `onMapFolder` bubble the top-bar
 *   actions to the app shell.
 * @returns The full viewer layout for the map.
 */
function MapViewer({
    map,
    slug,
    jsonPath,
    onSelectShowcase,
    onImport,
    onMapFolder,
    theme,
    onToggleTheme,
}: {
    map: CityMap;
    slug: string | null;
    jsonPath: string | null;
    onSelectShowcase: (showcase: Showcase) => void;
    onImport: () => void;
    onMapFolder: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}) {
    const nodeById = useMemo(() => new Map(map.nodes.map((node) => [node.id, node])), [map.nodes]);
    // Local change: campus structures may be district-less (no parentId).
    /**
     * Tests whether a node belongs on the campus (city-level) view: any
     * non-scope node whose parent is a district or missing.
     *
     * @param node - The node to classify.
     * @returns True when the node renders at campus level.
     */
    const isCampusNode = useCallback(
        (node: CityNode) => node.kind !== "scope" && (!node.parentId || nodeById.get(node.parentId)?.kind === "scope"),
        [nodeById],
    );
    // Start deselected: the panel opens on the map summary.
    const [selectedId, setSelectedId] = useState("");
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [focusId, setFocusId] = useState<string | null>(null);
    const [neighborhoodId, setNeighborhoodId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [hoverCard, setHoverCard] = useState<{ node: CityNode; x: number; y: number } | null>(null);
    const [overheadView, setOverheadView] = useState(false);
    /**
     * Shows or hides the floating hover card for a node.
     *
     * @param node - The hovered node, or null to dismiss the card.
     * @param x - Pointer clientX for card placement.
     * @param y - Pointer clientY for card placement.
     */
    const handleHover = useCallback((node: CityNode | null, x: number, y: number) => {
        setHoverCard(node ? { node, x, y } : null);
    }, []);

    const campusNodes = useMemo(() => map.nodes.filter(isCampusNode), [isCampusNode, map.nodes]);
    const visibleNodes = campusNodes;
    const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
    const visibleEdges = useMemo(() => {
        const projected = new Map<string, CityEdge>();
        const evidencePriority: Record<EvidenceKind, number> = { observed: 3, declared: 2, inferred: 1 };
        map.edges.forEach((edge) => {
            const from = closestVisibleAncestor(edge.from, nodeById, visibleIds);
            const to = closestVisibleAncestor(edge.to, nodeById, visibleIds);
            if (!from || !to || from === to) return;
            const key = `${from}->${to}`;
            const existing = projected.get(key);
            if (!existing || evidencePriority[edge.evidence] > evidencePriority[existing.evidence]) {
                projected.set(key, { ...edge, id: `campus:${key}`, from, to });
            }
        });
        return [...projected.values()];
    }, [map.edges, nodeById, visibleIds]);
    const activeExpandedId = expandedId && visibleIds.has(expandedId) ? expandedId : null;
    const activeFocusId = focusId && visibleIds.has(focusId) && !activeExpandedId ? focusId : null;
    const expandedNode = activeExpandedId ? nodeById.get(activeExpandedId) : undefined;
    const focusedNode = activeFocusId ? nodeById.get(activeFocusId) : undefined;
    const expandedChildren = useMemo(
        () => (activeExpandedId ? map.nodes.filter((node) => node.parentId === activeExpandedId) : []),
        [activeExpandedId, map.nodes],
    );
    const sceneIds = useMemo(
        () => new Set([...visibleNodes.map((node) => node.id), ...expandedChildren.map((node) => node.id)]),
        [expandedChildren, visibleNodes],
    );
    const layout = useMemo(
        () => computeFlowLayout(visibleNodes, visibleEdges, map.nodes),
        [map.nodes, visibleEdges, visibleNodes],
    );
    const activeNeighborhoodId =
        neighborhoodId &&
        layout.neighborhoods.some((neighborhood) => neighborhood.id === neighborhoodId) &&
        !activeExpandedId &&
        !activeFocusId
            ? neighborhoodId
            : null;
    // Local change: no forced selection — an empty selection shows the map
    // summary in the panel, and clicking the background deselects.
    const effectiveSelectedId = selectedId && sceneIds.has(selectedId) ? selectedId : "";
    const selected = effectiveSelectedId ? nodeById.get(effectiveSelectedId) : undefined;
    const focusConnections = activeFocusId
        ? visibleEdges.filter((edge) => edge.from === activeFocusId || edge.to === activeFocusId)
        : [];
    const selectedConnection = map.edges.find((edge) => edge.id === selectedConnectionId);
    const selectedConnectionFrom = selectedConnection
        ? closestVisibleAncestor(selectedConnection.from, nodeById, visibleIds)
        : null;
    const selectedConnectionTo = selectedConnection
        ? closestVisibleAncestor(selectedConnection.to, nodeById, visibleIds)
        : null;
    const campusActiveEdgeId =
        selectedConnectionFrom && selectedConnectionTo && selectedConnectionFrom !== selectedConnectionTo
            ? `campus:${selectedConnectionFrom}->${selectedConnectionTo}`
            : null;
    const filteredRailNodes = visibleNodes.filter((node) =>
        `${node.label} ${node.kind} ${node.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
    );
    // Rail view model: neighbourhoods that still hold a matching node, each
    // with its band heading (only on the first section of a new band).
    const railSections: SidebarSection[] = [];
    let lastRailBand: number | undefined;
    layout.neighborhoods.forEach((neighborhood, neighborhoodIndex) => {
        const neighborhoodIds = new Set(neighborhood.nodeIds);
        const nodes = filteredRailNodes
            .filter((node) => neighborhoodIds.has(node.id))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (!nodes.length) return;
        const showBandHeader = neighborhood.bandLabel !== undefined && neighborhood.band !== lastRailBand;
        lastRailBand = neighborhood.band;
        railSections.push({
            id: neighborhood.id,
            label: neighborhood.label,
            index: neighborhoodIndex,
            bandLabel: showBandHeader ? neighborhood.bandLabel : undefined,
            accent: NEIGHBORHOOD_ACCENTS[neighborhoodIndex % NEIGHBORHOOD_ACCENTS.length] ?? "transparent",
            active: activeNeighborhoodId === neighborhood.id,
            rows: nodes.map((node) => {
                const roomCount = map.nodes.filter((candidate) => candidate.parentId === node.id).length;
                return {
                    id: node.id,
                    label: node.label,
                    markerIndex: visibleNodes.indexOf(node),
                    typeLabel: plainType(node, roomCount),
                    entryPoint: node.archetype === "gateway",
                    landmark: roomCount > 0,
                    quieter: node.kind === "external",
                    selected: node.id === effectiveSelectedId,
                };
            }),
        });
    });

    /**
     * Finds the first map edge that, projected to campus level, touches the
     * given campus node — used to preselect a connection on node selection.
     *
     * @param nodeId - The campus node's id.
     * @returns The first matching edge, or undefined when none touch it.
     */
    const firstCampusConnection = useCallback(
        (nodeId: string) => {
            return map.edges.find((edge) => {
                const from = closestVisibleAncestor(edge.from, nodeById, visibleIds);
                const to = closestVisibleAncestor(edge.to, nodeById, visibleIds);
                return from && to && from !== to && (from === nodeId || to === nodeId);
            });
        },
        [map.edges, nodeById, visibleIds],
    );

    /**
     * Finds a map edge whose campus-level projection runs between two campus
     * nodes, in either direction.
     *
     * @param leftId - One campus node id.
     * @param rightId - The other campus node id.
     * @returns The first matching edge, or undefined when none connects them.
     */
    function connectionBetween(leftId: string, rightId: string) {
        return map.edges.find((edge) => {
            const from = closestVisibleAncestor(edge.from, nodeById, visibleIds);
            const to = closestVisibleAncestor(edge.to, nodeById, visibleIds);
            return (from === leftId && to === rightId) || (from === rightId && to === leftId);
        });
    }

    /**
     * Selects a node (single click): updates the selection, preselects a
     * connection touching it, and drops focus mode when the pick is unrelated
     * to the focused node.
     *
     * @param nodeId - The clicked node's id (room or campus structure).
     */
    function selectNode(nodeId: string) {
        const campusNodeId = closestVisibleAncestor(nodeId, nodeById, visibleIds);
        const focusedConnection =
            activeFocusId && campusNodeId && campusNodeId !== activeFocusId
                ? connectionBetween(activeFocusId, campusNodeId)
                : null;
        if (activeFocusId && campusNodeId && campusNodeId !== activeFocusId && !focusedConnection) setFocusId(null);
        setSelectedId(nodeId);
        setSelectedConnectionId(
            focusedConnection?.id ??
                (campusNodeId ? firstCampusConnection(campusNodeId)?.id : null) ??
                map.edges.find((edge) => edge.from === nodeId || edge.to === nodeId)?.id ??
                null,
        );
    }

    /**
     * Opens a node (double-click or rail click): expands a building's rooms
     * when it has children, otherwise toggles focus mode on the node's campus
     * ancestor to trace its direct connections.
     *
     * @param nodeId - The activated node's id.
     */
    function exploreNode(nodeId: string) {
        setNeighborhoodId(null);
        const children = map.nodes.filter((node) => node.parentId === nodeId);
        if (children.length) {
            setFocusId(null);
            setExpandedId((current) => (current === nodeId ? null : nodeId));
            selectNode(nodeId);
            return;
        }
        if (activeExpandedId && nodeById.get(nodeId)?.parentId === activeExpandedId) {
            selectNode(nodeId);
            return;
        }
        const campusNodeId = closestVisibleAncestor(nodeId, nodeById, visibleIds);
        if (!campusNodeId) return;
        setExpandedId(null);
        if (campusNodeId === activeFocusId) {
            setFocusId(null);
            selectNode(campusNodeId);
            return;
        }
        setFocusId(campusNodeId);
        setSelectedId(nodeId);
        setSelectedConnectionId(firstCampusConnection(campusNodeId)?.id ?? null);
    }

    /**
     * Toggles neighbourhood mode: zooms to a district, selecting its first
     * node, or leaves the mode when the same district is chosen again.
     *
     * @param nextNeighborhoodId - The district (neighbourhood) id to explore.
     */
    function exploreNeighborhood(nextNeighborhoodId: string) {
        if (activeNeighborhoodId === nextNeighborhoodId) {
            setNeighborhoodId(null);
            return;
        }
        const neighborhood = layout.neighborhoods.find((candidate) => candidate.id === nextNeighborhoodId);
        const firstNodeId = neighborhood?.nodeIds[0];
        if (!neighborhood || !firstNodeId) return;
        setExpandedId(null);
        setFocusId(null);
        setNeighborhoodId(nextNeighborhoodId);
        setSelectedId(firstNodeId);
        setSelectedConnectionId(firstCampusConnection(firstNodeId)?.id ?? null);
    }

    /** Leaves the interior view, reselecting the building that was open. */
    function closeBuilding() {
        if (activeExpandedId) selectNode(activeExpandedId);
        setExpandedId(null);
    }

    /** Leaves focus (connections) mode, reselecting the focused node. */
    function closeFocus() {
        if (activeFocusId) selectNode(activeFocusId);
        setFocusId(null);
    }

    /** Leaves neighbourhood mode, returning to the whole city. */
    function closeNeighborhood() {
        setNeighborhoodId(null);
    }

    useEffect(() => {
        /**
         * Escape steps back one view level: interior, then focus, then
         * neighbourhood mode.
         *
         * @param event - The window keydown event.
         */
        function handleKeyDown(event: KeyboardEvent) {
            if (event.key !== "Escape") return;
            if (expandedId) {
                setSelectedId(expandedId);
                setSelectedConnectionId(firstCampusConnection(expandedId)?.id ?? null);
                setExpandedId(null);
            } else if (focusId) {
                setSelectedId(focusId);
                setSelectedConnectionId(firstCampusConnection(focusId)?.id ?? null);
                setFocusId(null);
            } else if (neighborhoodId) {
                setNeighborhoodId(null);
            }
        }
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [expandedId, firstCampusConnection, focusId, neighborhoodId]);

    // Overlay view model: the three drill-down levels share one back button
    // and one breadcrumb slot, so they collapse into a single description.
    const overlayBack = activeExpandedId
        ? closeBuilding
        : activeFocusId
          ? closeFocus
          : activeNeighborhoodId
            ? closeNeighborhood
            : null;
    const overlayBreadcrumb = activeExpandedId
        ? { root: map.name, detail: `${expandedNode?.label ?? ""} rooms open` }
        : activeFocusId
          ? {
                root: focusedNode?.label ?? "",
                detail: `${focusConnections.length} direct connection${focusConnections.length === 1 ? "" : "s"}${
                    selectedConnection?.label ? ` · ${selectedConnection.label}` : ""
                }`,
            }
          : activeNeighborhoodId
            ? {
                  root: map.name,
                  detail:
                      layout.neighborhoods.find((neighborhood) => neighborhood.id === activeNeighborhoodId)?.label ??
                      "",
              }
            : null;
    const overlayHelp = activeExpandedId
        ? "Select a room · Esc to return · the city remains around you"
        : activeFocusId
          ? "Click a connected structure to trace that path · Esc to return"
          : activeNeighborhoodId
            ? "Choose a building to open it · Esc to return to the whole city"
            : "Click a structure or nameplate to select · double-click to open";

    // Both the hover card and the inspector describe the same node; the
    // inspector falls back to the map summary when nothing is under either.
    const hoveredRoomCount = hoverCard
        ? map.nodes.filter((candidate) => candidate.parentId === hoverCard.node.id).length
        : 0;
    const hoverDetails = hoverCard
        ? hoverCardDetails(hoverCard.node, hoveredRoomCount)
        : { paths: [] as string[], facts: [] as HoverFact[] };
    const inspectorShown = hoverCard?.node ?? selected;
    const inspectorContent: InspectorContent = inspectorShown
        ? nodeInspectorContent(
              map,
              inspectorShown,
              map.nodes.filter((candidate) => candidate.parentId === inspectorShown.id).length,
          )
        : mapInspectorContent(
              map,
              layout.neighborhoods.filter((neighborhood) => !neighborhood.id.startsWith("__")).length,
              visibleNodes,
              visibleEdges.length,
          );

    return (
        <main className="shell">
            <Topbar
                showcases={showcases}
                selectedSlug={slug}
                placeholder="(opened file)"
                onSelectShowcase={onSelectShowcase}
                repoName={map.name}
                repoPath={!slug && map.repository ? map.repository : undefined}
                mapFilePath={!slug && jsonPath ? jsonPath : undefined}
                onOpenMap={onImport}
                onMapFolder={onMapFolder}
                theme={theme}
                onToggleTheme={onToggleTheme}
            />

            <Sidebar
                search={search}
                onSearchChange={setSearch}
                sections={railSections}
                onExploreSection={exploreNeighborhood}
                onSelectRow={exploreNode}
            />

            <section className="viewport" aria-label="Interactive repository city">
                {visibleNodes.length ? (
                    <CityScene
                        background={theme === "dark" ? SCENE_PAPER_DARK : SCENE_PAPER}
                        ink={theme === "dark" ? SCENE_INK_ON_DARK : SCENE_INK}
                        nodes={visibleNodes}
                        allNodes={map.nodes}
                        edges={visibleEdges}
                        allEdges={map.edges}
                        selectedId={effectiveSelectedId}
                        activeEdgeId={campusActiveEdgeId}
                        interiorActiveEdgeId={selectedConnectionId}
                        expandedId={activeExpandedId}
                        focusId={activeFocusId}
                        neighborhoodId={activeNeighborhoodId}
                        onSelect={selectNode}
                        onEnter={exploreNode}
                        onHover={handleHover}
                        viewKey={`${map.id}:${activeExpandedId ? `rooms:${activeExpandedId}` : activeFocusId ? `connections:${activeFocusId}` : activeNeighborhoodId ? `neighborhood:${activeNeighborhoodId}` : "campus"}`}
                        overheadView={overheadView}
                        onDeselect={() => {
                            setSelectedId("");
                            setSelectedConnectionId(null);
                        }}
                    />
                ) : (
                    <div className="empty-view">
                        <strong>No mapped structures.</strong>
                    </div>
                )}
                <Legend />
                <HoverDetails
                    at={hoverCard ? { x: hoverCard.x + 18, y: hoverCard.y - 12 } : null}
                    title={hoverCard?.node.label ?? ""}
                    paths={hoverDetails.paths}
                    facts={hoverDetails.facts}
                />
                <ViewportOverlays
                    overhead={overheadView}
                    onOverheadChange={setOverheadView}
                    onBack={overlayBack}
                    statusLabel={`Front → back flow · ${layout.neighborhoods.length} neighborhoods`}
                    breadcrumb={overlayBreadcrumb}
                    helpText={overlayHelp}
                />
            </section>

            <Inspector content={inspectorContent} />
        </main>
    );
}

/**
 * The application root: holds the currently loaded map (showcase, opened
 * file, or generated), the hidden file input for imports, and the folder
 * browser overlay; shows the empty shell until a map is loaded.
 *
 * @returns The viewer or empty shell, plus the import input and any overlay.
 */
export default function Functionary() {
    const { theme, toggleTheme } = useTheme();
    const [current, setCurrent] = useState<{ map: CityMap | null; slug: string | null; jsonPath: string | null }>({
        map: null,
        slug: null,
        jsonPath: null,
    });
    const fileInput = useRef<HTMLInputElement>(null);

    /**
     * Loads a bundled showcase map as the current map.
     *
     * @param showcase - The showcase entry to display.
     */
    function openShowcase(showcase: Showcase) {
        setCurrent({ map: showcase.map, slug: showcase.slug, jsonPath: null });
    }

    const [browserOpen, setBrowserOpen] = useState(false);

    /**
     * Handles a chosen map file: parses the JSON, validates it against the
     * schema, and either loads it or alerts with the first few errors. The
     * input is cleared so re-picking the same file fires again.
     *
     * @param event - The file input's change event.
     */
    async function importMap(event: ChangeEvent<HTMLInputElement>) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text()) as unknown;
            const errors = validateCityMap(parsed);
            if (errors.length) throw new Error(errors.slice(0, 3).join(" "));
            const nextMap = parsed as CityMap;
            setCurrent({ map: nextMap, slug: null, jsonPath: file.name });
        } catch (error) {
            window.alert(error instanceof Error ? `Map rejected: ${error.message}` : "Map rejected: invalid JSON.");
        } finally {
            event.target.value = "";
        }
    }

    /**
     * Loads a map produced by the folder browser's generator and closes the
     * overlay.
     *
     * @param payload - The generated map and the path it was written to.
     */
    function acceptGenerated(payload: { map: CityMap; jsonPath: string }) {
        setCurrent({ map: payload.map, slug: null, jsonPath: payload.jsonPath });
        setBrowserOpen(false);
    }

    return (
        <>
            <input
                ref={fileInput}
                className="sr-only"
                type="file"
                accept="application/json,.json"
                onChange={importMap}
            />
            {current.map ? (
                <MapViewer
                    key={current.map.id}
                    map={current.map}
                    slug={current.slug}
                    jsonPath={current.jsonPath}
                    onSelectShowcase={openShowcase}
                    onImport={() => fileInput.current?.click()}
                    onMapFolder={() => setBrowserOpen(true)}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                />
            ) : (
                <EmptyShell
                    onSelectShowcase={openShowcase}
                    onImport={() => fileInput.current?.click()}
                    onMapFolder={() => setBrowserOpen(true)}
                    theme={theme}
                    onToggleTheme={toggleTheme}
                />
            )}
            {browserOpen && <FolderBrowser onClose={() => setBrowserOpen(false)} onGenerated={acceptGenerated} />}
        </>
    );
}

/**
 * The landing screen shown before any map is loaded: the map picker, open and
 * map-a-folder actions, and one card per bundled showcase.
 *
 * @param props - `onSelectShowcase` loads a showcase; `onImport` opens the
 *   file picker; `onMapFolder` opens the folder browser.
 * @returns The empty-state layout with showcase cards.
 */
function EmptyShell({
    onSelectShowcase,
    onImport,
    onMapFolder,
    theme,
    onToggleTheme,
}: {
    onSelectShowcase: (showcase: Showcase) => void;
    onImport: () => void;
    onMapFolder: () => void;
    theme: Theme;
    onToggleTheme: () => void;
}) {
    return (
        <main className="flex min-h-screen flex-col bg-background text-foreground">
            <Topbar
                showcases={showcases}
                selectedSlug={null}
                placeholder="Choose a map"
                onSelectShowcase={onSelectShowcase}
                onOpenMap={onImport}
                onMapFolder={onMapFolder}
                theme={theme}
                onToggleTheme={onToggleTheme}
            />
            <EmptyState
                showcases={showcases}
                onSelectShowcase={onSelectShowcase}
                onOpenMap={onImport}
                onMapFolder={onMapFolder}
            />
        </main>
    );
}
