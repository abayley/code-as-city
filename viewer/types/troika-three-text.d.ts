// Minimal typings for troika-three-text: only the surface RepoCity.tsx uses.
declare module "troika-three-text" {
    import type * as THREE from "three";

    /**
     * Configures Troika's global text typesetting pipeline before any Text
     * instances are created.
     *
     * @param config - Typesetting options; `useWorker` chooses whether glyph
     *   layout runs in a web worker or on the main thread.
     */
    export function configureTextBuilder(config: { useWorker?: boolean }): void;

    /** A three.js mesh that renders SDF text; RepoCity uses it for nameplates and signs. */
    export class Text extends THREE.Mesh {
        text: string;
        fontSize: number;
        color: string | number;
        anchorX: "left" | "center" | "right" | number;
        anchorY: "top" | "middle" | "bottom" | number;
        maxWidth: number;
        lineHeight: number;
        textAlign: "left" | "center" | "right" | "justify";
        fillOpacity: number;
        sync(callback?: () => void): void;
        dispose(): void;
    }
}
