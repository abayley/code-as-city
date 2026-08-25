// Minimal typings for troika-three-text: only the surface RepoCity.tsx uses.
declare module "troika-three-text" {
    import type * as THREE from "three";

    export function configureTextBuilder(config: { useWorker?: boolean }): void;

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
