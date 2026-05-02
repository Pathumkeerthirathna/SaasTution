type TeacherLoginSnapshot = {
  teacherId: string;
  loggedAt: Date;
};

type LoginStore = {
  teachers: Map<string, TeacherLoginSnapshot>;
};

type GlobalWithLoginStore = typeof globalThis & {
  __saastutionLoginStore?: LoginStore;
};

function getStore(): LoginStore {
  const globalStore = globalThis as GlobalWithLoginStore;

  if (!globalStore.__saastutionLoginStore) {
    globalStore.__saastutionLoginStore = {
      teachers: new Map<string, TeacherLoginSnapshot>(),
    };
  }

  return globalStore.__saastutionLoginStore;
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
