import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  icon?: ReactNode;
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

export function Button({
  children,
  icon,
  variant = "primary",
  fullWidth = false,
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`kt-button kt-button--${variant}${fullWidth ? " kt-button--full" : ""} ${className}`.trim()}
      type={type}
      {...props}
    >
      {icon ? <span aria-hidden="true" className="kt-button__icon">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  eyebrow?: ReactNode;
  media?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export function Card({
  title,
  eyebrow,
  media,
  actions,
  children,
  className = "",
  ...props
}: CardProps) {
  return (
    <article className={`kt-card ${className}`.trim()} {...props}>
      {media ? <div className="kt-card__media">{media}</div> : null}
      <div className="kt-card__body">
        {eyebrow ? <p className="kt-card__eyebrow">{eyebrow}</p> : null}
        {title ? <h2 className="kt-card__title">{title}</h2> : null}
        <div className="kt-card__content">{children}</div>
        {actions ? <div className="kt-card__actions">{actions}</div> : null}
      </div>
    </article>
  );
}

export type StatusTone = "success" | "warning" | "danger" | "neutral" | "info";

const statusSymbols: Record<StatusTone, string> = {
  success: "✓",
  warning: "!",
  danger: "×",
  neutral: "–",
  info: "i",
};

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: StatusTone;
}

export function StatusChip({ children, tone = "neutral", className = "", ...props }: StatusChipProps) {
  return (
    <span className={`kt-status kt-status--${tone} ${className}`.trim()} {...props}>
      <span aria-hidden="true" className="kt-status__symbol">{statusSymbols[tone]}</span>
      <span>{children}</span>
    </span>
  );
}

interface FieldCopyProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

function FieldCopy({ id, label, hint, error }: FieldCopyProps) {
  return (
    <>
      <label className="kt-field__label" htmlFor={id}>{label}</label>
      {hint ? <p className="kt-field__hint" id={`${id}-hint`}>{hint}</p> : null}
      {error ? <p className="kt-field__error" id={`${id}-error`} role="alert"><span aria-hidden="true">!</span> {error}</p> : null}
    </>
  );
}

function describedBy(id: string, hint?: ReactNode, error?: ReactNode) {
  return [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id">, FieldCopyProps {}

export function TextInput({ id, label, hint, error, className = "", ...props }: TextInputProps) {
  return (
    <div className={`kt-field ${className}`.trim()}>
      <FieldCopy error={error} hint={hint} id={id} label={label} />
      <input
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
        className="kt-input"
        id={id}
        {...props}
      />
    </div>
  );
}

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">, FieldCopyProps {
  options: readonly SelectOption[];
}

export function SelectField({ id, label, hint, error, options, className = "", ...props }: SelectFieldProps) {
  return (
    <div className={`kt-field ${className}`.trim()}>
      <FieldCopy error={error} hint={hint} id={id} label={label} />
      <select
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
        className="kt-select"
        id={id}
        {...props}
      >
        {options.map((option) => (
          <option disabled={option.disabled} key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">, FieldCopyProps {}

export function TextArea({ id, label, hint, error, className = "", ...props }: TextAreaProps) {
  return (
    <div className={`kt-field ${className}`.trim()}>
      <FieldCopy error={error} hint={hint} id={id} label={label} />
      <textarea
        aria-describedby={describedBy(id, hint, error)}
        aria-invalid={error ? true : undefined}
        className="kt-textarea"
        id={id}
        {...props}
      />
    </div>
  );
}

export interface FormActionsProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function FormActions({ children, className = "", ...props }: FormActionsProps) {
  return <div className={`kt-form-actions ${className}`.trim()} {...props}>{children}</div>;
}

export interface CheckboxFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
}

export function CheckboxField({ id, label, hint, className = "", ...props }: CheckboxFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label className={`kt-checkbox ${className}`.trim()} htmlFor={id}>
      <input aria-describedby={hintId} id={id} type="checkbox" {...props} />
      <span className="kt-checkbox__copy">
        <span className="kt-checkbox__label">{label}</span>
        {hint ? <span className="kt-checkbox__hint" id={hintId}>{hint}</span> : null}
      </span>
    </label>
  );
}

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "onClick" | "role" | "type"> {
  checked: boolean;
  label: ReactNode;
  checkedLabel: string;
  uncheckedLabel: string;
  onCheckedChange: (checked: boolean) => void;
}

export function Switch({
  checked,
  label,
  checkedLabel,
  uncheckedLabel,
  onCheckedChange,
  className = "",
  disabled,
  ...props
}: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      className={`kt-switch ${className}`.trim()}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      role="switch"
      type="button"
      {...props}
    >
      <span aria-hidden="true" className="kt-switch__track"><span className="kt-switch__thumb" /></span>
      <span className="kt-switch__copy">
        <span className="kt-switch__label">{label}</span>
        <span className="kt-switch__state">{checked ? checkedLabel : uncheckedLabel}</span>
      </span>
    </button>
  );
}
