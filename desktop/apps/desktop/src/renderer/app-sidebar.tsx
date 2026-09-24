import type { RefObject } from "react";
import type { ProjectSummary, TaskSummary } from "@pfsaa/domain";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import { SidebarSkeleton, TaskRow } from "./ui";

type AppCopy = (typeof copy)[Language];

export interface AppSidebarProps {
  language: Language;
  t: AppCopy;
  sidebarRef: RefObject<HTMLElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  mobileSidebarOpen: boolean;
  sidebarCollapsed: boolean;
  backgroundInert?: boolean;
  projectCwd: string;
  projects: ProjectSummary[];
  projectTasksByCwd: Record<string, TaskSummary[]>;
  projectTaskLoads: Record<string, { status: "idle" | "loading" | "ready" | "error"; error?: string }>;
  expandedProjectCwds: string[];
  searchQuery: string;
  activeTask: TaskSummary | null;
  initialLoading: boolean;
  runtimeStatus: "connected" | "starting" | "disconnected";
  shortcut: (key: string) => string;
  onCloseMobile: () => void;
  onToggleSidebar: () => void;
  onCreateTask: () => void | Promise<unknown>;
  onCreateTaskForProject: (project: ProjectSummary) => void | Promise<unknown>;
  onSearchQuery: (value: string) => void;
  onSelectProject: (project: ProjectSummary) => void | Promise<unknown>;
  onSelectTask: (project: ProjectSummary, task: TaskSummary) => void | Promise<unknown>;
  onOpenTaskContext: (task: TaskSummary, x: number, y: number) => void;
  onTaskMenu: (task: TaskSummary, rect: DOMRect) => void;
  onLoadProjectSessions: (project: ProjectSummary) => void | Promise<unknown>;
  onRetry: () => void | Promise<unknown>;
}

export function AppSidebar({
  language, t, sidebarRef, searchInputRef, mobileSidebarOpen, sidebarCollapsed, backgroundInert = false, projectCwd, projects,
  projectTasksByCwd, projectTaskLoads, expandedProjectCwds, searchQuery, activeTask,
  initialLoading, runtimeStatus, shortcut, onCloseMobile, onCreateTask, onCreateTaskForProject,
  onToggleSidebar, onSearchQuery, onSelectProject, onSelectTask,
  onOpenTaskContext, onTaskMenu, onLoadProjectSessions, onRetry,
}: AppSidebarProps) {
  const normalizedQuery = searchQuery.toLocaleLowerCase();
  return <>
    <aside ref={sidebarRef} id="workspace-sidebar" className={`sidebar ${mobileSidebarOpen ? "mobile-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} aria-label={t.openNavigation} inert={backgroundInert} aria-hidden={backgroundInert || undefined}>
      <div className="sidebar-mobile-header"><strong>{t.projects}</strong><button className="icon-button" type="button" title={t.closeNavigation} aria-label={t.closeNavigation} onClick={onCloseMobile}><Icon name="x" /></button></div>
      <button className="new-task" type="button" title={t.newTask} aria-label={t.newTask} disabled={!projectCwd || initialLoading} onClick={() => { onCloseMobile(); void onCreateTask(); }}><span className="new-task-icon"><Icon name="plus" /></span><span>{t.newTask}</span><kbd>{shortcut("N")}</kbd></button>
      <label className="search-box"><Icon name="search" size={15} /><input ref={searchInputRef} type="search" value={searchQuery} onChange={(event) => onSearchQuery(event.target.value)} placeholder={t.search} aria-label={t.search} /><kbd>/</kbd></label>
      <div className="sidebar-scroll">
        <div className="section-label"><span>{t.projects}</span><button className="sidebar-collapse-toggle" type="button" title={sidebarCollapsed ? t.expandSidebar : t.collapseSidebar} aria-label={sidebarCollapsed ? t.expandSidebar : t.collapseSidebar} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" onClick={onToggleSidebar}><Icon name="chevron" size={14} /></button></div>
        <div className="project-list">
          {initialLoading && projects.length === 0 && <SidebarSkeleton />}
          {!initialLoading && projects.length === 0 && <div className="empty-sidebar"><strong>{t.noProjects}</strong></div>}
          {projects.map((project) => {
            const selected = project.cwd === projectCwd;
            const expanded = expandedProjectCwds.includes(project.cwd);
            // Every expanded group renders from its own cwd-scoped cache. During
            // a cross-project switch, `projectCwd` updates before the selected
            // project's asynchronous load completes; borrowing the global
            // active `tasks` list here briefly duplicated the previous project.
            const projectTasks = projectTasksByCwd[project.cwd] ?? [];
            const filteredProjectTasks = projectTasks.filter((task) => task.title.toLocaleLowerCase().includes(normalizedQuery));
            const projectTaskLoad = projectTaskLoads[project.cwd] ?? { status: selected && initialLoading ? "loading" as const : "idle" as const };
            return <section className={`project-group ${selected ? "selected" : ""} ${expanded ? "expanded" : ""}`} key={project.id}>
              <button className="project-row" type="button" disabled={initialLoading} aria-label={project.name} aria-expanded={expanded} title={sidebarCollapsed ? project.name : project.cwd} onClick={() => void onSelectProject(project)}>
                <Icon name={expanded ? "folderOpen" : "folder"} size={17} />
                <span className="project-row-copy"><strong>{project.name}</strong></span>
                <Icon name="chevron" size={14} />
              </button>
              <div className="project-sessions" aria-hidden={!expanded}><div className="task-list">
                {projectTaskLoad.status === "loading" && projectTasks.length === 0 ? <SidebarSkeleton /> : filteredProjectTasks.map((task) => <TaskRow key={task.id} task={task} active={selected && activeTask?.id === task.id} language={language} onClick={() => void onSelectTask(project, task)} onContextMenu={(event) => { event.preventDefault(); onOpenTaskContext(task, event.clientX, event.clientY); }} onMenu={(rect) => onTaskMenu(task, rect)} />)}
                {projectTaskLoad.status === "error" && <div className="empty-sidebar" role="alert"><strong>{t.projectSessionsLoadFailed}</strong><span>{projectTaskLoad.error}</span><button className="button ghost" type="button" onClick={() => void onLoadProjectSessions(project)}>{t.retry}</button></div>}
                {projectTaskLoad.status === "ready" && filteredProjectTasks.length === 0 && <div className="empty-sidebar"><strong>{searchQuery ? t.noSessionMatches : t.noSessions}</strong><span>{searchQuery ? t.tryAnotherSearch : t.createFirst}</span>{!searchQuery && <button className="button primary" type="button" onClick={() => void onCreateTaskForProject(project)}><Icon name="plus" size={14} />{t.newTask}</button>}</div>}
              </div></div>
            </section>;
          })}
        </div>
      </div>
      <div className="sidebar-footer">
        <div className={`runtime-status ${runtimeStatus}`} aria-label={runtimeStatus === "connected" ? t.connected : runtimeStatus === "starting" ? t.runtimeStarting : t.runtimeDisconnected}><span className="status-dot" /><span>{runtimeStatus === "connected" ? t.connected : runtimeStatus === "starting" ? t.runtimeStarting : t.runtimeDisconnected}</span>{runtimeStatus === "disconnected" && <button type="button" title={t.retry} aria-label={t.retry} onClick={() => void onRetry()}>{t.retry}</button>}</div>
      </div>
    </aside>
    {mobileSidebarOpen && <button className="sidebar-backdrop" type="button" tabIndex={-1} title={t.closeNavigation} aria-label={t.closeNavigation} onClick={onCloseMobile} />}
  </>;
}
