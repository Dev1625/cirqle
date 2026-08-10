export const RESUME_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_PDF_MAX_PAGES = 40;
export const RESUME_TEXT_MAX_CHARACTERS = 200_000;

export type ResumePDFErrorCode =
  | 'not-pdf'
  | 'file-too-large'
  | 'page-limit'
  | 'text-too-large'
  | 'scanned-or-empty'
  | 'malformed'
  | 'cancelled';

export class ResumePDFError extends Error {
  code: ResumePDFErrorCode;

  constructor(code: ResumePDFErrorCode, message: string) {
    super(message);
    this.name = 'ResumePDFError';
    this.code = code;
  }
}

interface PDFTextItem {
  str?: unknown;
}

interface PDFPage {
  getTextContent: () => Promise<{ items?: PDFTextItem[] }>;
  cleanup?: () => void;
}

interface PDFDocument {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PDFPage>;
  destroy?: () => Promise<void> | void;
}

export interface ResumePDFFile extends Blob {
  name?: string;
  type: string;
}

function assertNotCancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new ResumePDFError('cancelled', 'Resume extraction was canceled.');
  }
}

async function defaultOpenDocument(data: ArrayBuffer): Promise<PDFDocument> {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] =
    await Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker?url'),
    ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;
  // pdfjs-dist 6 dropped the bare-buffer overload; the buffer now travels as
  // an explicit `data` source parameter.
  return getDocument({ data }).promise as unknown as Promise<PDFDocument>;
}

function cleanPageText(items: PDFTextItem[] | undefined): string {
  return (items || [])
    .map((item) => (typeof item.str === 'string' ? item.str.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function extractResumePDF(
  file: ResumePDFFile,
  options: {
    signal?: AbortSignal;
    onProgress?: (page: number, totalPages: number) => void;
    openDocument?: (data: ArrayBuffer) => Promise<PDFDocument>;
  } = {},
): Promise<string> {
  assertNotCancelled(options.signal);
  if (
    file.size <= 0 ||
    file.size > RESUME_PDF_MAX_BYTES
  ) {
    throw new ResumePDFError(
      'file-too-large',
      `Choose a PDF smaller than ${RESUME_PDF_MAX_BYTES / 1024 / 1024} MB.`,
    );
  }
  const name = (file.name || '').toLowerCase();
  if (
    file.type !== 'application/pdf' &&
    !(file.type === '' && name.endsWith('.pdf'))
  ) {
    throw new ResumePDFError('not-pdf', 'Choose a PDF resume.');
  }

  const header = new TextDecoder('ascii').decode(
    await file.slice(0, 5).arrayBuffer(),
  );
  if (header !== '%PDF-') {
    throw new ResumePDFError(
      'not-pdf',
      'The selected file does not contain a valid PDF header.',
    );
  }
  assertNotCancelled(options.signal);

  let pdf: PDFDocument | null = null;
  try {
    pdf = await (options.openDocument || defaultOpenDocument)(
      await file.arrayBuffer(),
    );
    assertNotCancelled(options.signal);
    if (
      !Number.isInteger(pdf.numPages) ||
      pdf.numPages < 1
    ) {
      throw new ResumePDFError('malformed', 'This PDF has no readable pages.');
    }
    if (pdf.numPages > RESUME_PDF_MAX_PAGES) {
      throw new ResumePDFError(
        'page-limit',
        `Choose a resume with ${RESUME_PDF_MAX_PAGES} pages or fewer.`,
      );
    }

    const pages: string[] = [];
    let characterCount = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      assertNotCancelled(options.signal);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      page.cleanup?.();
      const text = cleanPageText(content.items);
      characterCount += text.length + 1;
      if (characterCount > RESUME_TEXT_MAX_CHARACTERS) {
        throw new ResumePDFError(
          'text-too-large',
          'The extracted resume text is too large to store safely.',
        );
      }
      if (text) pages.push(text);
      options.onProgress?.(pageNumber, pdf.numPages);
    }
    const result = pages.join('\n').trim();
    if (result.length < 40) {
      throw new ResumePDFError(
        'scanned-or-empty',
        'This PDF appears scanned or contains too little selectable text. Use an OCR/text PDF or paste the resume text.',
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ResumePDFError) throw error;
    if (options.signal?.aborted) {
      throw new ResumePDFError('cancelled', 'Resume extraction was canceled.');
    }
    throw new ResumePDFError(
      'malformed',
      'That PDF could not be read. Try exporting it again or paste the text.',
    );
  } finally {
    await pdf?.destroy?.();
  }
}
