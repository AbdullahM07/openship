import type { StackId } from "@repo/core";

export interface Framework {
  id: string;
  name: string;
  icon: React.ReactNode;
}

export interface RepoData {
  repo: string;
  owner: string;
  branch: string;
  private: boolean | false;
}

export interface EnvironmentVariable {
  key: string;
  value: string;
  visible: boolean;
  /**
   * The row's plaintext was intentionally not loaded (a saved secret or a
   * source-scanned value). Deploy serialization sends the mask sentinel so the
   * API can recover it from its trusted store/source. Any edit clears this.
   */
  preserveValue?: boolean;
}

export type StartCommand = string;

export type FrameworkId = StackId;

export interface ProjectSettingsProps {
  projectName: string;
  setProjectName: (name: string) => void;
  framework: FrameworkId;
  handleFrameworkChange: (frameworkId: FrameworkId) => void;
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  branches: string[];
  loadingBranches: boolean;
}

export interface BuildSettingsProps {
  framework: FrameworkId;
  buildCommand: string;
  setBuildCommand: (command: string) => void;
  outputDirectory: string;
  setOutputDirectory: (directory: string) => void;
  installCommand: string;
  setInstallCommand: (command: string) => void;
  startCommand: StartCommand;
  setStartCommand: (command: string) => void;
  rootDirectory: string;
  setRootDirectory: (directory: string) => void;
  productionPort: string;
  setProductionPort: (port: string) => void;
  hasServer: boolean;
  setHasServer: (hasServer: boolean) => void;
  projectName: string;
}

export interface EnvironmentVariablesProps {
  envVars: EnvironmentVariable[];
  setEnvVars: React.Dispatch<React.SetStateAction<EnvironmentVariable[]>>;
  mode?: "deploy" | "settings";
  showEditControls?: boolean;
  isEditingMode?: boolean;
  setIsEditingMode?: (value: boolean) => void;
  showAddButton?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
}

export interface HeaderProps {
  repoData: RepoData;
}

export interface SidebarProps {
  repoData: RepoData;
  framework: FrameworkId;
  isDeploying: boolean;
  handleDeploy: () => void;
}
