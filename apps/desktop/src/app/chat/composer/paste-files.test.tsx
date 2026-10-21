// @vitest-environment jsdom
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DroppedFile } from '@/app/chat/hooks/use-composer-actions'
import { I18nProvider } from '@/i18n'

import { RICH_INPUT_SLOT } from './rich-editor'
import type { ChatBarState } from './types'

import { ChatBar } from './index'

// THE INVARIANT: a file copied in Finder/Explorer is attached AS THAT FILE.
//
// The OS clipboard for a copied file carries a second, image-typed item — the
// file's icon — alongside the file itself. The paste handler used to read
// images first, so on macOS an .xlsx arrived at the gateway as a 1024x1024 PNG
// of the Excel icon and the workbook bytes never left the machine. Files must
// be consulted before image blobs; only a clipboard with no on-disk file (a
// screenshot) may reach the image path, unchanged.

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { enabled: false, active: false }
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Screenshot-shaped bytes: big enough to clear extractClipboardImageBlobs. */
const imageFile = (name: string) => new File([new Uint8Array(8192)], name, { type: 'image/png' })

interface HarnessProps {
  onAttachDroppedItems: (candidates: DroppedFile[]) => Promise<boolean>
  onAttachImageBlob: (blob: Blob) => Promise<boolean>
}

function Harness({ onAttachDroppedItems, onAttachImageBlob }: HarnessProps) {
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    messages: [] as ThreadMessageLike[],
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          <ChatBar
            busy={false}
            disabled={false}
            gateway={null}
            onAttachDroppedItems={onAttachDroppedItems}
            onAttachImageBlob={onAttachImageBlob}
            onCancel={vi.fn()}
            onSubmit={vi.fn(async () => true)}
            state={state}
          />
        </I18nProvider>
      </MemoryRouter>
    </AssistantRuntimeProvider>
  )
}

/**
 * The clipboard shape a Finder/Explorer copy produces: the real file plus an
 * image-typed icon representation. `paths` maps a File to the path Electron's
 * webUtils.getPathForFile would return for it ('' for clipboard-only data).
 */
function clipboard(files: File[], paths: Map<File, string>, text = ''): DataTransfer {
  return {
    files: { item: (i: number) => files[i] ?? null, length: files.length },
    getData: (type: string) => (type === 'text' || type === 'text/plain' ? text : ''),
    items: files.map(file => ({ getAsFile: () => file, kind: 'file', type: file.type }))
  } as unknown as DataTransfer
}

function pasteInto(editor: HTMLElement, clip: DataTransfer) {
  // jsdom does not implement isContentEditable, so the app's window-level paste
  // router would treat this target as page chrome. Pin it, as the sibling
  // paste tests do.
  Object.defineProperty(editor, 'isContentEditable', { configurable: true, value: true })
  editor.focus()

  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', { value: clip })

  act(() => {
    fireEvent(editor, event)
  })

  return event
}

function setup() {
  const onAttachDroppedItems = vi.fn(async () => true)
  const onAttachImageBlob = vi.fn(async () => true)

  const { container } = render(
    <Harness onAttachDroppedItems={onAttachDroppedItems} onAttachImageBlob={onAttachImageBlob} />
  )

  const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

  return { editor, onAttachDroppedItems, onAttachImageBlob }
}

describe('pasting a file into the composer', () => {
  it('attaches the workbook, not the image representation of its icon', async () => {
    const workbook = new File([new Uint8Array([1, 2, 3])], 'books.xlsx', { type: XLSX_MIME })
    const icon = imageFile('books.xlsx.png')

    // getPathForFile resolves the copied file; the icon has no path on disk.
    const paths = new Map<File, string>([
      [workbook, '/Users/test/Desktop/books.xlsx'],
      [icon, '']
    ])

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { getPathForFile: (file: File) => paths.get(file) ?? '' }
    })

    const { editor, onAttachDroppedItems, onAttachImageBlob } = setup()

    const event = pasteInto(editor, clipboard([workbook, icon], paths))

    expect(event.defaultPrevented).toBe(true)
    await act(async () => {})

    expect(onAttachDroppedItems).toHaveBeenCalledOnce()
    expect(onAttachDroppedItems).toHaveBeenCalledWith([
      expect.objectContaining({
        file: workbook,
        fromPaste: true,
        path: '/Users/test/Desktop/books.xlsx'
      })
    ])
    // The icon never rides the image pipeline, which is what used to reach the
    // gateway as a picture of Excel.
    expect(onAttachImageBlob).not.toHaveBeenCalled()
  })

  it('attaches a .png copied from Finder as a file, not as a screenshot', async () => {
    const picked = imageFile('shot.png')
    const paths = new Map<File, string>([[picked, '/Users/test/Desktop/shot.png']])

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { getPathForFile: (file: File) => paths.get(file) ?? '' }
    })

    const { editor, onAttachDroppedItems, onAttachImageBlob } = setup()

    pasteInto(editor, clipboard([picked], paths))
    await act(async () => {})

    expect(onAttachDroppedItems).toHaveBeenCalledWith([
      expect.objectContaining({ file: picked, fromPaste: true, path: '/Users/test/Desktop/shot.png' })
    ])
    expect(onAttachImageBlob).not.toHaveBeenCalled()
  })

  it('leaves a screenshot on the image path', async () => {
    const shot = imageFile('image.png')

    // A copied screenshot is clipboard data only — no file on disk.
    const paths = new Map<File, string>([[shot, '']])

    Object.defineProperty(window, 'hermesDesktop', {
      configurable: true,
      value: { getPathForFile: (file: File) => paths.get(file) ?? '' }
    })

    const { editor, onAttachDroppedItems, onAttachImageBlob } = setup()

    pasteInto(editor, clipboard([shot], paths))
    await act(async () => {})

    expect(onAttachImageBlob).toHaveBeenCalledOnce()
    expect(onAttachImageBlob).toHaveBeenCalledWith(shot)
    expect(onAttachDroppedItems).not.toHaveBeenCalled()
  })
})
