declare module 'diff' {
  export type StructuredHunk = {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: string[];
  };

  export type StructuredPatch = {
    oldFileName: string;
    newFileName: string;
    hunks: StructuredHunk[];
  };

  export function structuredPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number; stripTrailingCr?: boolean },
  ): StructuredPatch;

  export function createTwoFilesPatch(
    oldFileName: string,
    newFileName: string,
    oldStr: string,
    newStr: string,
    oldHeader?: string,
    newHeader?: string,
    options?: { context?: number; stripTrailingCr?: boolean },
  ): string;
}
