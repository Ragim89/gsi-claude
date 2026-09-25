import { ChangeEvent, FormEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button, Card, EmptyState, Field, Input, Select, Table } from '@gsi/ui-kit/react';
import { DOCUMENT_CATEGORIES, DocumentCategory, DocumentEntityType, DocumentRecord } from '@gsi/shared-types';
import { api } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Loading, useFormatDate } from './common';

/** Generic documents section, embedded on client/job/inspection/sample detail pages (PHASE 10). */
export function DocumentsCard({ entityType, entityId }: { entityType: DocumentEntityType; entityId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const fmt = useFormatDate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [title, setTitle] = useState('');

  const canUpload = can('document.upload');
  const canArchive = can('document.archive');
  const queryKey = ['documents', entityType, entityId];

  const documents = useQuery({
    queryKey,
    queryFn: () => api.get<DocumentRecord[]>(`/documents?entityType=${entityType}&entityId=${entityId}`),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const data = new FormData();
      data.append('file', file);
      data.append('entityType', entityType);
      data.append('entityId', entityId);
      data.append('category', category);
      data.append('title', title.trim() || file.name);
      return api.upload<DocumentRecord>('/documents', data);
    },
    onSuccess: () => {
      setAdding(false);
      setTitle('');
      setCategory('other');
      qc.invalidateQueries({ queryKey });
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api.post(`/documents/${id}/archive`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) upload.mutate(file);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    fileRef.current?.click();
  }

  const rows = documents.data ?? [];

  return (
    <Card
      title={t('documents.title')}
      actions={
        canUpload && !adding ? (
          <Button size="sm" onClick={() => setAdding(true)}>
            + {t('documents.add')}
          </Button>
        ) : null
      }
    >
      <ErrorBox error={documents.error ?? upload.error ?? archive.error} />
      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp"
        hidden
        onChange={onFile}
      />

      {adding && (
        <form className="form-grid" onSubmit={submit} style={{ marginBlockEnd: 'var(--gsi-space-4)' }}>
          <Field label={t('documents.category')}>
            <Select value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)}>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`documents.categories.${c}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('documents.docTitle')}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('documents.docTitleHint')} />
          </Field>
          <div className="row-actions">
            <Button type="submit" loading={upload.isPending}>
              {t('documents.chooseFile')}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}

      {documents.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState>{t('documents.empty')}</EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>{t('documents.docTitle')}</th>
              <th>{t('documents.category')}</th>
              <th>{t('documents.uploadedBy')}</th>
              <th>{t('documents.uploadedAt')}</th>
              {canArchive && <th style={{ width: 100 }}>{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.downloadUrl ? (
                    <a href={d.downloadUrl} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                  ) : (
                    d.title
                  )}
                  {d.version > 1 ? <span className="muted"> v{d.version}</span> : null}
                </td>
                <td>{t(`documents.categories.${d.category}`)}</td>
                <td>{d.uploadedByName ?? '—'}</td>
                <td>{fmt(d.uploadedAt)}</td>
                {canArchive && (
                  <td>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => window.confirm(t('documents.confirmArchive')) && archive.mutate(d.id)}
                    >
                      {t('documents.archive')}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
