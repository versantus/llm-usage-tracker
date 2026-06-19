// Bun text imports (`import x from './f.ps1' with { type: 'text' }`) yield a string.
declare module '*.ps1' {
    const content: string;
    export default content;
}
