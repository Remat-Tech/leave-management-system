import { useState } from 'react';
import { type ExportFormat, isNotSignedIn, saveExport } from './api';
import { Icon } from './Icon';
import { type Problem, problemFrom } from './problem';

/** Saves what is on screen as CSV or XLSX. FR 64, LMS 511. */
export function ExportButtons({
  path,
  onSignedOut,
  onProblem,
}: {
  /** The export route, with the filters on screen and no format. */
  path: string;
  onSignedOut: () => void;
  onProblem: (problem: Problem | undefined) => void;
}) {
  const [saving, setSaving] = useState<ExportFormat | undefined>(undefined);

  const save = (format: ExportFormat) => {
    setSaving(format);

    saveExport(path, format)
      .then(() => {
        onProblem(undefined);
      })
      .catch((error: unknown) => {
        if (isNotSignedIn(error)) {
          onSignedOut();
          return;
        }

        onProblem(problemFrom(error));
      })
      .finally(() => {
        setSaving(undefined);
      });
  };

  return (
    <div className="export-buttons">
      {(['csv', 'xlsx'] as const).map((format) => (
        <button
          key={format}
          type="button"
          disabled={saving !== undefined}
          onClick={() => {
            save(format);
          }}
        >
          <Icon name="download" />
          {saving === format ? 'Saving…' : format === 'csv' ? 'CSV' : 'Excel'}
        </button>
      ))}
    </div>
  );
}
