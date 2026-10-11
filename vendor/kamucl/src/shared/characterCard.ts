/** Persona text is kept verbatim; appearance is independent from the AI prompt. */
export interface CharacterDocument { name: string; text: string }
export interface CharacterSkin { png: string; variant: 'classic' | 'slim' }
export interface CharacterYsm { model: string; texture?: string; assetId?: string }
export interface CharacterAppearance { skin?: CharacterSkin; ysm?: CharacterYsm }
export interface CharacterInput extends CharacterDocument { id?: string; avatar?: string; appearance?: CharacterAppearance | null }
export interface CharacterCard extends CharacterDocument { id: string; avatar?: string; appearance?: CharacterAppearance; createdAt: number; updatedAt: number }
export interface CharacterSummary { id: string; name: string; excerpt: string; avatar?: string; appearance?: CharacterAppearance; updatedAt: number }
export interface CharacterBinding { cardId: string }
export interface YsmOptions { currentModel?: string; currentTexture?: string; models: string[]; textures: string[] }
