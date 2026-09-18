import type { AttachedArtifact } from './ipc-types'

/**
 * Folds attachments into the plain-text prompt right before it reaches
 * council-core - the AIProvider/CouncilRequest contract's `content` field
 * stays a plain string, so this is the one place that has to know
 * attachments exist at all. Each artifact gets a clear header so the model
 * can tell "the user's ask" apart from "the evidence attached to it."
 * Pulled into its own module (no electron/council-core/provider imports)
 * so it's testable without any of that setup.
 */
export function withAttachments(prompt: string, attachments: AttachedArtifact[] | undefined): string {
  if (!attachments || attachments.length === 0) return prompt
  const blocks = attachments.map((a) => `--- Anhang: ${a.label} ---\n${a.text}`)
  return [prompt, ...blocks].join('\n\n')
}
