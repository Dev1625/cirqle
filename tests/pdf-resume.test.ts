import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractResumePDF,
  ResumePDFError,
  RESUME_PDF_MAX_BYTES,
  type ResumePDFFile,
} from '../src/lib/pdfResume';

function pdfFile(
  body = '%PDF-1.7 fixture',
  overrides: Partial<ResumePDFFile> = {},
): ResumePDFFile {
  const blob = new Blob([body], { type: 'application/pdf' });
  return Object.assign(blob, { name: 'resume.pdf' }, overrides);
}

function documentWithPages(texts: string[]) {
  return {
    numPages: texts.length,
    async getPage(pageNumber: number) {
      return {
        async getTextContent() {
          return {
            items: texts[pageNumber - 1]
              .split(' ')
              .map((str) => ({ str })),
          };
        },
      };
    },
  };
}

test('valid selectable-text PDF extracts bounded editable text', async () => {
  const result = await extractResumePDF(pdfFile(), {
    openDocument: async () =>
      documentWithPages([
        'Avery Stone product leader with ten years of experience.',
        'Built reliable customer systems and led a global team.',
      ]),
  });
  assert.match(result, /Avery Stone/);
  assert.match(result, /global team/);
});

test('scanned, malformed, oversized and spoofed PDFs fail with stable reasons', async () => {
  await assert.rejects(
    extractResumePDF(pdfFile(), {
      openDocument: async () => documentWithPages(['']),
    }),
    (error: unknown) =>
      error instanceof ResumePDFError && error.code === 'scanned-or-empty',
  );
  await assert.rejects(
    extractResumePDF(pdfFile(), {
      openDocument: async () => {
        throw new Error('parser internals');
      },
    }),
    (error: unknown) =>
      error instanceof ResumePDFError && error.code === 'malformed',
  );
  await assert.rejects(
    extractResumePDF(
      {
        name: 'resume.pdf',
        type: 'application/pdf',
        size: RESUME_PDF_MAX_BYTES + 1,
        slice: () => new Blob(['%PDF-']),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as ResumePDFFile,
    ),
    (error: unknown) =>
      error instanceof ResumePDFError && error.code === 'file-too-large',
  );
  await assert.rejects(
    extractResumePDF(pdfFile('not-a-pdf')),
    (error: unknown) =>
      error instanceof ResumePDFError && error.code === 'not-pdf',
  );
});

test('cancellation stops between pages and returns no partial resume text', async () => {
  const controller = new AbortController();
  await assert.rejects(
    extractResumePDF(pdfFile(), {
      signal: controller.signal,
      openDocument: async () =>
        documentWithPages([
          'First page contains enough selectable resume text for extraction.',
          'Second page should never become visible after cancellation.',
        ]),
      onProgress(page) {
        if (page === 1) controller.abort();
      },
    }),
    (error: unknown) =>
      error instanceof ResumePDFError && error.code === 'cancelled',
  );
});
