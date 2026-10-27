"use client";

import { translate, type CatalogLocale } from "@kisantractor/i18n";
import { useRef, useState, type FormEvent } from "react";

import { Button, FormActions, SelectField, TextInput } from "../ui";

interface UploadGrantResponse {
  readonly document?: { readonly id?: string };
  readonly grant?: {
    readonly url?: string;
    readonly method?: string;
    readonly requiredHeaders?: Readonly<Record<string, string>>;
  };
}

export function OwnerDocumentUpload({
  locale,
  tractorOptions,
}: {
  readonly locale: CatalogLocale;
  readonly tractorOptions: readonly { readonly id: string; readonly label: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "success" | "danger"; readonly text: string }>();

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("documentFile");
    if (!(file instanceof File) || file.size === 0) {
      setMessage({ tone: "danger", text: translate(locale, "owner.documents.fileRequired") });
      return;
    }

    setPending(true);
    setMessage(undefined);
    try {
      const grantResponse = await fetch("/api/owner/documents/upload-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tractorId: String(data.get("tractorId") ?? "") || undefined,
          documentKind: String(data.get("documentKind") ?? ""),
          fileName: file.name,
          declaredMimeType: file.type,
          sizeBytes: file.size,
        }),
      });
      if (!grantResponse.ok) throw new Error("Upload grant rejected");
      const granted = await grantResponse.json() as UploadGrantResponse;
      if (!granted.document?.id || !granted.grant?.url || granted.grant.method !== "PUT") {
        throw new Error("Invalid upload grant");
      }

      const uploaded = await fetch(granted.grant.url, {
        method: "PUT",
        headers: { ...granted.grant.requiredHeaders, "content-type": file.type },
        body: file,
      });
      if (!uploaded.ok) throw new Error("Private upload failed");

      const completed = await fetch(`/api/owner/documents/${encodeURIComponent(granted.document.id)}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!completed.ok) throw new Error("Document validation could not start");

      formRef.current?.reset();
      setMessage({ tone: "success", text: translate(locale, "owner.documents.uploaded") });
    } catch {
      setMessage({ tone: "danger", text: translate(locale, "owner.documents.uploadError") });
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="kt-owner-form kt-owner-document-upload" onSubmit={(event) => void submit(event)} ref={formRef}>
      <div className="kt-owner-form__grid">
        <SelectField
          id="documentTractor"
          label={translate(locale, "form.tractor")}
          name="tractorId"
          options={[
            { value: "", label: translate(locale, "owner.documents.ownerLevel") },
            ...tractorOptions.map((tractor) => ({ value: tractor.id, label: tractor.label })),
          ]}
        />
        <SelectField
          id="documentKind"
          label={translate(locale, "owner.documents.kind")}
          name="documentKind"
          options={[
            { value: "REGISTRATION_CERTIFICATE", label: translate(locale, "owner.documents.registrationCertificate") },
            { value: "INSURANCE", label: translate(locale, "owner.documents.insurance") },
            { value: "OTHER", label: translate(locale, "owner.documents.other") },
          ]}
          required
        />
      </div>
      <TextInput
        accept="application/pdf,image/jpeg,image/png,image/webp"
        id="documentFile"
        label={translate(locale, "owner.documents.chooseFile")}
        name="documentFile"
        required
        type="file"
      />
      <p className="kt-owner-document-upload__help">{translate(locale, "owner.documents.privateHelp")}</p>
      <FormActions><Button disabled={pending} type="submit">{translate(locale, pending ? "owner.documents.uploading" : "owner.documents.upload")}</Button></FormActions>
      {message ? <p aria-live="polite" className={`kt-owner-feedback kt-owner-feedback--${message.tone}`} role={message.tone === "danger" ? "alert" : "status"}>{message.text}</p> : null}
    </form>
  );
}
