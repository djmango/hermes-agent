import { type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, useRef, useState } from 'react'

import { triggerHaptic } from '@/lib/haptics'

import { extractDroppedFiles, HERMES_PATHS_MIME, partitionDroppedFiles } from '../../hooks/use-composer-actions'
import { dragHasAttachments, droppedFileInlineRefs, type InlineRefInput } from '../inline-refs'
import type { ChatBarProps } from '../types'

interface UseComposerDropArgs {
  cwd: ChatBarProps['cwd']
  insertInlineRefs: (refs: InlineRefInput[]) => boolean
  onAttachDroppedItems: ChatBarProps['onAttachDroppedItems']
  requestMainFocus: () => void
}

/**
 * Drag-and-drop attachment engine. Splits drops by origin: in-app drags
 * (project tree / gutter) stay inline `@file:`/`@line:` refs the gateway
 * resolves directly; OS/Finder drops (absolute local paths a remote gateway
 * can't read, image bytes vision needs) route through the upload pipeline.
 * Off the keystroke path; consumes `insertInlineRefs` + the attach handler.
 */
export function useComposerDrop({
  cwd,
  insertInlineRefs,
  onAttachDroppedItems,
  requestMainFocus
}: UseComposerDropArgs) {
  const [dragActive, setDragActive] = useState(false)
  const dragDepthRef = useRef(0)

  const resetDragState = () => {
    dragDepthRef.current = 0
    setDragActive(false)
  }

  const handleDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1

    if (!dragActive) {
      setDragActive(true)
    }
  }

  const handleDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems || !dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setDragActive(false)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    if (!onAttachDroppedItems) {
      return
    }

    event.preventDefault()
    resetDragState()

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (candidates.length === 0) {
      return
    }

    // In-app drags (project tree / gutter) are workspace-relative paths the
    // gateway resolves directly, so they stay inline @file:/@line: refs. OS
    // drops are absolute local paths a remote gateway can't read (and images
    // need byte upload for vision), so route them through the upload pipeline.
    const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
    const refs = droppedFileInlineRefs(inAppRefs, cwd)

    if (refs.length && insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }

    if (osDrops.length) {
      void Promise.resolve(onAttachDroppedItems(osDrops)).then(attached => {
        if (attached) {
          triggerHaptic('selection')
          requestMainFocus()
        }
      })
    }
  }

  const handleInputDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  const handleInputDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!dragHasAttachments(event.dataTransfer, HERMES_PATHS_MIME)) {
      return
    }

    const candidates = extractDroppedFiles(event.dataTransfer)

    if (!candidates.length) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    resetDragState()

    // Dropping straight onto the text box used to inline-ref *every* file —
    // including OS/Finder drops, whose absolute local path a remote gateway
    // can't read and whose image bytes never reached vision. Split by origin:
    // in-app drags stay inline refs; OS drops go through the upload pipeline.
    // (When no upload handler is wired, fall back to inline refs for all.)
    const attach = onAttachDroppedItems
    const { inAppRefs, osDrops } = partitionDroppedFiles(candidates)
    const refs = droppedFileInlineRefs(attach ? inAppRefs : candidates, cwd)

    if (refs.length && insertInlineRefs(refs)) {
      triggerHaptic('selection')
    }

    if (attach && osDrops.length) {
      void Promise.resolve(attach(osDrops)).then(attached => {
        if (attached) {
          triggerHaptic('selection')
          requestMainFocus()
        }
      })
    }
  }

  return {
    dragActive,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleInputDragOver,
    handleInputDrop
  }
}

/**
 * Pasting a file copied in Finder/Explorer. The clipboard carries the file AND
 * an image representation of its icon, so reading image blobs first attaches a
 * picture of Excel instead of the workbook. Files win: any clipboard File that
 * resolves to an on-disk path is attached as a file chip.
 *
 * Returns false when the clipboard holds no on-disk file — a screenshot, which
 * is what the image-blob path exists for; the caller then falls back. Reads
 * the transfer synchronously: it detaches once the paste handler returns, and
 * `webUtils.getPathForFile` needs the original File reference. Consumes the
 * event (preventDefault) only when it takes the paste.
 */
export function attachPastedFiles(
  event: ReactClipboardEvent<HTMLDivElement>,
  { onAttachDroppedItems, requestMainFocus }: Pick<UseComposerDropArgs, 'onAttachDroppedItems' | 'requestMainFocus'>
): boolean {
  if (!onAttachDroppedItems) {
    return false
  }

  const pasted = extractDroppedFiles(event.clipboardData).filter(candidate =>
    Boolean(candidate.file && candidate.path)
  )

  if (!pasted.length) {
    return false
  }

  event.preventDefault()

  void Promise.resolve(onAttachDroppedItems(pasted.map(candidate => ({ ...candidate, fromPaste: true })))).then(
    attached => {
      if (attached) {
        triggerHaptic('selection')
        requestMainFocus()
      }
    }
  )

  return true
}
