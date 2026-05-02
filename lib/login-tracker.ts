type TeacherLoginSnapshot = {
  teacherId: string;
  loggedAt: Date;
};

type LoginStore = {
  teachers: Map<string, TeacherLoginSnapshot>;
};

declare global {
  var __saastutionLoginStore: LoginStore | undefined;
}

function getStore(): LoginStore {
  if (!globalThis.__saastutionLoginStore) {
    globalThis.__saastutionLoginStore = {
      teachers: new Map<string, TeacherLoginSnapshot>(),
    };
  }

  return globalThis.__saastutionLoginStore;
}

export function markTeacherLoggedIn(teacherId: string) {
  getStore().teachers.set(teacherId, {
    teacherId,
    loggedAt: new Date(),
  });
}

export function getLoggedInTeacherSnapshots() {
  return Array.from(getStore().teachers.values()).sort((a, b) => b.loggedAt.getTime() - a.loggedAt.getTime());
}
