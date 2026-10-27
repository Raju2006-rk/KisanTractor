import type { ReactNode } from "react";

export type StepState = "complete" | "current" | "upcoming";

export interface Step {
  id: string;
  label: ReactNode;
  state: StepState;
  statusLabel: string;
}

export interface StepperProps {
  steps: readonly Step[];
  label: string;
}

export function Stepper({ steps, label }: StepperProps) {
  return (
    <nav aria-label={label} className="kt-stepper">
      <ol>
        {steps.map((step, index) => (
          <li
            aria-current={step.state === "current" ? "step" : undefined}
            className={`kt-stepper__step kt-stepper__step--${step.state}`}
            key={step.id}
          >
            <span aria-hidden="true" className="kt-stepper__marker">
              {step.state === "complete" ? "✓" : index + 1}
            </span>
            <span className="kt-stepper__copy">
              <span className="kt-stepper__label">{step.label}</span>
              <span className="kt-stepper__status">{step.statusLabel}</span>
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
