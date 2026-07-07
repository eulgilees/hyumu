window.Hyumu = window.Hyumu || {};

Hyumu.Scheduler = (function () {
  const Model = Hyumu.Model;

  function setCell(schedule, empId, date, status, source, shift, holidayChoice) {
    schedule[empId][date] = { status, source, shift: shift || null, holidayChoice: holidayChoice || null };
  }

  function isLocked(schedule, empId, date) {
    const cell = schedule[empId][date];
    return !!cell && (cell.source === 'BASE' || cell.source === 'MANUAL');
  }

  // Personal annual leave (연차) and 인정 leave are separate from the fairness/rest-day
  // rotation: an employee who already used annual leave should still receive their full
  // share of auto-assigned rest on top of it, not have the annual leave count against it.
  const EXEMPT_LEAVE_TYPES = ['ANNUAL', 'RECOGNIZED'];
  function isExemptLockedOff(emp, date, schedule) {
    const cell = schedule[emp.id][date];
    if (!cell || cell.status !== 'OFF' || cell.source !== 'BASE') return false;
    if (!emp.specificOff.includes(date)) return false;
    return EXEMPT_LEAVE_TYPES.includes(Model.leaveTypeOf(emp, date));
  }

  // Would giving `emp` a new OFF day on `date` push any of their corners below its own
  // morning+afternoon minimum? Used by the catch-up swap passes so they can't quietly
  // re-violate a corner minimum that Phase 1 already respected while chasing the target
  // off-days count.
  function wouldExceedCornerCap(schedule, employees, cornerAllowedOff, emp, date) {
    const empCorners = Model.employeeCorners(emp);
    if (empCorners.length === 0) return false;
    const cornerOffToday = {};
    employees.forEach((other) => {
      if (other.id === emp.id) return;
      // `other` may belong to a department group that hasn't run its Phase 1 fill yet (groups
      // run sequentially), so its cell for this date can still be unset — treat that as "not
      // off" rather than crashing; that group's own Phase 1 will account for it when it runs.
      const otherCell = schedule[other.id][date];
      if (!otherCell || otherCell.status !== 'OFF') return;
      Model.employeeCorners(other).forEach((c) => {
        cornerOffToday[c] = (cornerOffToday[c] || 0) + 1;
      });
    });
    return empCorners.some((c) => cornerAllowedOff[c] != null && (cornerOffToday[c] || 0) >= cornerAllowedOff[c]);
  }

  // 전달 문서의 말일 기준으로 각 직원의 실제 연속근무일수를 계산한다 — 이번 달 스케줄이 그
  // 연속근무를 이어받는 출발점으로 쓴다(직원 id가 전달과 이번 달에 같아야 이어받아짐).
  function computeCarryStreak(previousMonthDoc) {
    const carry = {};
    if (!previousMonthDoc || !previousMonthDoc.schedule || !previousMonthDoc.month) return carry;
    const prevDates = Model.allDatesOfMonth(previousMonthDoc.month.year, previousMonthDoc.month.month);
    Object.keys(previousMonthDoc.schedule).forEach((empId) => {
      let streak = 0;
      for (let i = prevDates.length - 1; i >= 0; i--) {
        const cell = previousMonthDoc.schedule[empId][prevDates[i]];
        if (cell && cell.status === 'WORK') streak++;
        else break;
      }
      carry[empId] = streak;
    });
    return carry;
  }

  // 공휴일에 근무하면 수당 또는 대체휴일 중 하나를 본인이 고른다(사장님 지시: "빨간날 근무는
  // 본인이 설정하게 해서 고를 수 있게 할까") — 대체휴일을 고른 날만큼 이번 달 목표 휴무일수에
  // 더해줘서, 그만큼 자동으로 하루 더 쉬게 배정되도록 한다. 이번 달 안에서만 쓰는 걸로
  // 한정한다(사장님 지시: "이번 달 안에서만 사용").
  function computeSubstituteBonus(oldSchedule, employees, dates) {
    const bonus = {};
    employees.forEach((emp) => {
      let count = 0;
      const empSchedule = oldSchedule && oldSchedule[emp.id];
      if (empSchedule) {
        dates.forEach((d) => {
          const cell = empSchedule[d];
          if (cell && cell.status === 'WORK' && Model.holidayName(d) && Model.holidayChoiceOf(emp, empSchedule, d) === 'SUBSTITUTE') count++;
        });
      }
      bonus[emp.id] = count;
    });
    return bonus;
  }

  function generateSchedule(doc, previousMonthDoc) {
    const { employees, rules, month } = doc;
    const dates = Model.allDatesOfMonth(month.year, month.month);
    const carryStreakByEmpId = computeCarryStreak(previousMonthDoc);
    const substituteBonusByEmpId = computeSubstituteBonus(doc.schedule, employees, dates);

    const schedule = {};
    employees.forEach((emp) => {
      schedule[emp.id] = {};
    });

    // BASE cells are always recomputed fresh from employee definitions
    for (const emp of employees) {
      for (const date of dates) {
        if (Model.isBaseOff(emp, date)) {
          setCell(schedule, emp.id, date, 'OFF', 'BASE');
        }
      }
    }

    // carry forward previously saved MANUAL locks
    if (doc.schedule) {
      for (const emp of employees) {
        const prevEmp = doc.schedule[emp.id];
        if (!prevEmp) continue;
        for (const date of dates) {
          const prevCell = prevEmp[date];
          if (prevCell && prevCell.source === 'MANUAL') {
            setCell(schedule, emp.id, date, prevCell.status, 'MANUAL', prevCell.shift);
          }
        }
      }
    }

    const conflicts = [];

    if (employees.length === 0) {
      doc.schedule = schedule;
      doc.conflicts = conflicts;
      return doc;
    }

    // 문구/서적은 각자 최소근무인원/연속근무/오전조/오후조 기준이 별도라서(사장님 지시),
    // 부서별로 완전히 독립적인 인원 풀로 나눠서 각자의 Phase 1 + 재조정을 따로 돌린다.
    // 관리(점장/파트장/영업지원)는 어느 부서에도 안 속하니 store-wide 기본 규칙(rules 최상위
    // 필드)을 그대로 쓰는 별도 풀로 처리한다.
    const deptEmployees = { '문구': [], '서적': [] };
    const adminEmployees = [];
    employees.forEach((emp) => {
      const dept = Model.employeeDepartment(emp);
      if (dept === '문구' || dept === '서적') deptEmployees[dept].push(emp);
      else adminEmployees.push(emp);
    });

    // 코너별(기프트/학용/문보장 등) 오전+오후 최소 인원은 부서 분리와 무관하게 매장 전체
    // 기준으로 지켜져야 한다 — 예를 들어 기프트 담당자 중 한 명이 파트장을 겸해 관리 그룹으로
    // 빠지더라도, 문구 그룹과 관리 그룹이 서로 몰라서 같은 날 기프트를 동시에 비우면 안 된다.
    // 그래서 코너 인원수/허용 휴무치는 부서별이 아니라 전체 employees 기준으로 한 번만 계산해
    // 모든 그룹의 Phase 1/재조정 패스에 공통으로 넘긴다.
    const cornerShiftMinGlobal = rules.minStaffByCorner || {};
    const cornerMinStaffGlobal = {};
    Object.entries(cornerShiftMinGlobal).forEach(([corner, req]) => {
      cornerMinStaffGlobal[corner] = (req.morning || 0) + (req.afternoon || 0);
    });
    const cornerTotalGlobal = {};
    employees.forEach((emp) => {
      Model.employeeCorners(emp).forEach((c) => {
        cornerTotalGlobal[c] = (cornerTotalGlobal[c] || 0) + 1;
      });
    });
    // 파트장은 몇 명이 동시에 쉬든 상관없지만, 매장에 파트장이 단 한 명도 없는 날은 절대
    // 없어야 한다(사장님 지시: "최대 1명은 근무해야 한다는거야" — 동시에 여럿이 쉬는 건 괜찮고,
    // 항상 최소 1명은 근무해야 한다는 뜻). 코너 최소 인원 설정 여부와 무관하게 이 하한을
    // 강제로 걸어둔다. 사용자가 규칙 화면에서 '파트장' 코너에 이보다 더 엄격한(=더 높은)
    // 오전/오후 최소치를 직접 설정했다면 그 값이 우선한다.
    const partLeaderCount = cornerTotalGlobal['파트장'] || 0;
    if (partLeaderCount > 0) {
      cornerMinStaffGlobal['파트장'] = Math.max(cornerMinStaffGlobal['파트장'] || 0, 1);
    }
    const cornerAllowedOff = {};
    Object.keys(cornerTotalGlobal).forEach((corner) => {
      cornerAllowedOff[corner] = Math.max(0, cornerTotalGlobal[corner] - (cornerMinStaffGlobal[corner] || 0));
    });

    // Collected across every group so backfillPartLeaders can tell whether pulling a specific
    // 파트장 back to WORK would drop them below their own guaranteed rest-day count, and so a
    // final safety pass can verify nobody's consecutive-work cap got broken along the way.
    const targetByEmpId = {};
    const personalCapByEmpId = {};

    const deptRules = rules.deptRules || {};
    ['문구', '서적'].forEach((dept) => {
      if (deptEmployees[dept].length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});
      const result = runGroupSchedule(deptEmployees[dept], groupRules, schedule, dates, conflicts, employees, cornerAllowedOff, cornerMinStaffGlobal, undefined, carryStreakByEmpId, substituteBonusByEmpId);
      Object.assign(targetByEmpId, result.target);
      Object.assign(personalCapByEmpId, result.personalCap);
    });

    // Dates where 문구/서적's own dedicated staff already falls short of their department
    // minimum — these are exactly the dates backfillPartLeaders will later need to pull a 파트장
    // into WORK on. Computed now (after 문구/서적 are scheduled, before 관리 is) so the 관리
    // group's own slack-fill pass below can avoid spending a 파트장's extra rest day on one of
    // these dates — otherwise slack-fill hands a day off to whoever's most behind, backfill then
    // immediately takes it back (since with the "max 1 파트장 off/day" cap, whoever slack-fill
    // picked is often the *only* 파트장 free to pull that day), and the two passes fight every
    // regeneration instead of the group ever actually evening out.
    const deptShortfallDates = new Set();
    ['문구', '서적'].forEach((dept) => {
      if (deptEmployees[dept].length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});
      dates.forEach((date) => {
        const req = Math.max(Model.minStaffRequired(groupRules, date), (groupRules.minMorningStaff || 0) + (groupRules.minAfternoonStaff || 0));
        const working = deptEmployees[dept].filter((e) => schedule[e.id][date].status === 'WORK').length;
        if (working < req) deptShortfallDates.add(date);
      });
    });

    if (adminEmployees.length > 0) {
      // 관리(점장/파트장/영업지원)는 store-wide 최소인원 수치를 그대로 물려받으면 안 된다 —
      // 그 수치는 문구/서적처럼 여러 명 규모의 부서를 염두에 두고 정한 값이라, 관리 인원(대개
      // 1~3명)에 그대로 적용하면 매일 인원 부족으로 뜬다. 관리는 인원 하한 없이 목표
      // 휴무일수 페이스와 연속근무 제한만 따른다(점장은 상관없다는 사장님 지시).
      const adminRules = Object.assign({}, rules, { minStaffDefault: 0, minMorningStaff: 0, minAfternoonStaff: 0 });
      const adminResult = runGroupSchedule(adminEmployees, adminRules, schedule, dates, conflicts, employees, cornerAllowedOff, cornerMinStaffGlobal, deptShortfallDates, carryStreakByEmpId, substituteBonusByEmpId);
      Object.assign(targetByEmpId, adminResult.target);
      Object.assign(personalCapByEmpId, adminResult.personalCap);
    }

    // 파트장은 어느 한 부서가 도저히 최소인원을 못 맞출 때 그 부서에 투입돼야 한다(사장님 지시) —
    // 단, 그 파트장 본인의 목표 휴무일수(법정 휴무: 빨간날/공휴일 + 이미 쓴 연차·체단·인정)를
    // 깎으면서까지는 안 된다. 휴무 갯수는 넘버원 원칙이라, 이미 목표만큼만 쉬고 있는 사람은
    // 투입 대상에서 제외한다(사장님 지시: "가깝게? 그거 안돼... 법적으로 지켜야할 사항이야").
    backfillPartLeaders(schedule, employees, deptEmployees, deptRules, rules, dates, conflicts, targetByEmpId);

    // Fix any corner (기프트/문보장 등) that still falls short of its own morning+afternoon
    // minimum after everything else has run — first from within the corner's own staff, then by
    // pulling in a 파트장 as floating coverage (사장님 지시).
    backfillCornerShortfalls(schedule, employees, dates, cornerMinStaffGlobal, personalCapByEmpId, conflicts);

    // 목표 휴무일수는 필수 조건이라 무조건 맞춰야 한다(사장님 지시: "필수는 무조건이라 억지로
    // 라도 끼워맞춰야해") — 코너 최소인원 여유가 없어서(예: 파트장이 1명뿐이라 항상 근무해야
    // 하는 경우) 위 패스들이 목표만큼 못 쉬게 했다면, 여기서 코너 하한을 깨더라도 강제로
    // 채운다.
    enforceTargetOffDays(schedule, employees, dates, targetByEmpId, cornerMinStaffGlobal, personalCapByEmpId, conflicts);

    // 매달 최소 한 번은 이틀 이상 붙여 쉬어야 한다(사장님 지시: "한달에 이틀 이상 붙여쉬는 날이
    // 한 번은 있어야해 최소 이틀이야"). 목표 휴무일수(넘버원 원칙)는 절대 안 건드리고, 이미
    // 배정된 휴무 중 하나의 날짜만 옮겨서 다른 휴무 바로 옆에 붙인다.
    if (rules.requireBackToBackOff) {
      enforceBackToBackRest(schedule, employees, dates, cornerMinStaffGlobal, conflicts);
    }

    // 마지막으로, 목표 휴무일수 예산 안에서도 도저히 상한을 지킬 수 없었던 연속근무 구간을
    // 찾아 오류로 표시한다(사장님 지시: "강제휴무란 있을 수 없어... 길게 근무하는 경우 오류를
    // 뜨게 해줘야해") — 스케줄을 억지로 고치지 않고 있는 그대로 보고만 한다.
    detectConsecutiveCapViolations(schedule, employees, dates, personalCapByEmpId, conflicts);

    assignShifts(schedule, employees, dates, rules, conflicts);

    doc.schedule = schedule;
    doc.conflicts = conflicts;
    return doc;
  }

  // Runs the full Phase 1 greedy fill + rebalance passes for one self-contained pool of
  // employees (a department, or the 관리 catch-all), writing into the shared `schedule` and
  // `conflicts`. Everything here only ever looks at `groupEmployees` — no cross-group effects.
  function runGroupSchedule(groupEmployees, rules, schedule, dates, conflicts, allEmployees, cornerAllowedOff, cornerMinStaffGlobal, excludeDatesForSlack, carryStreakByEmpId, substituteBonusByEmpId) {
    const n = groupEmployees.length;
    const employees = groupEmployees;

    // 이번 달 1일을 다들 "방금 입사한 사람"처럼 0일째로 취급하면, 아무도 아직 상한에 안
    // 닿았으니 전원이 나흘째에 동시에 상한을 맞아버린다(사장님 지시: "전달 휴무를 고려해서
    // 월초 휴무까지 짜야하는데 그걸 안줘서 일이 이렇게 복잡해진것 같다") — 전달 말일 기준
    // 실제 연속근무일수를 이어받아 시작하면 자연스럽게 이미 흩어진 상태로 출발하게 된다.
    const consecutiveWork = {};
    const totalOff = {};
    const weekendOff = {};
    const redDayOff = {};
    const fairnessOff = {};
    employees.forEach((emp) => {
      consecutiveWork[emp.id] = (carryStreakByEmpId && carryStreakByEmpId[emp.id]) || 0;
      totalOff[emp.id] = 0;
      weekendOff[emp.id] = 0;
      redDayOff[emp.id] = 0;
      fairnessOff[emp.id] = 0;
    });

    // lockedOffCount excludes exempt (연차/인정) leave so those days don't eat into the
    // guaranteed auto-rest target; fairnessOff (built up below in the Phase 1 loop) mirrors
    // this by excluding exempt days from the running deficit calculation too.
    const lockedOffCount = {};
    employees.forEach((emp) => {
      lockedOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedOffCount[emp.id]++;
      }
    }

    // 목표 휴무일수(rules.targetOffDays)가 있으면 그게 곧 목표다 — 최소 근무 인원에서
    // 역산한 값이 아니라, 사용자가 직접 정한 숫자. 최소 인원 요건은 이 목표를 채우는 데
    // 방해가 되면 안 되고(휴무가 최우선), 아래 Phase 1에서도 일일 남은 슬롯 계산을 이
    // 목표에 맞춰 페이싱하지 최소인원 여유분으로 캡을 걸지 않는다.
    // targetOffDays를 직접 입력하지 않으면 이번 달 토/일 일수를 그대로 목표 휴무일수로 쓴다
    // (사장님 지시: "토/일만 계산하면 되거든").
    const baseTarget = rules.targetOffDays != null && rules.targetOffDays !== ''
      ? Number(rules.targetOffDays)
      : dates.filter((d) => Model.isWeekend(d)).length;
    const target = {};
    employees.forEach((emp) => {
      const substituteBonus = (substituteBonusByEmpId && substituteBonusByEmpId[emp.id]) || 0;
      target[emp.id] = Math.max(lockedOffCount[emp.id], baseTarget) + substituteBonus;
    });
    const totalTargetSum = employees.reduce((sum, emp) => sum + target[emp.id], 0);

    // cornerAllowedOff is the true hard ceiling (how many CAN rest without breaking the corner's
    // own minimum) — a corner like 학용/필기구/디자인문구 shares the same 6 people across all
    // three, so that ceiling is generous (up to 4 of 6 at once), and Phase 1 will happily spend
    // all of it on a slack day, then leave everyone working on a day nobody happens to need rest.
    // The result is lumpy day-to-day headcount even though every day is individually valid
    // (사장님 지시: "매일 비슷한 인원이 근무하게 하는게 목적이야"). This tighter smoothing cap —
    // roughly how many SHOULD be resting on an average day given the group's own target pace —
    // is what Phase 1's own discretionary picks respect; the real ceiling (cornerAllowedOff)
    // stays untouched for the later passes (backfill, target enforcement) that need the full
    // slack available when there's a genuine shortfall or deficit to fix.
    const cornerSmoothCap = {};
    Object.keys(cornerAllowedOff).forEach((corner) => {
      const members = employees.filter((e) => Model.employeeCorners(e).includes(corner));
      if (members.length === 0) return;
      const avgTarget = members.reduce((sum, e) => sum + (target[e.id] || 0), 0) / members.length;
      const avgDailyOff = (avgTarget / dates.length) * members.length;
      cornerSmoothCap[corner] = Math.min(cornerAllowedOff[corner], Math.max(1, Math.ceil(avgDailyOff) + 1));
    });

    const cap = rules.maxConsecutiveWorkDays;
    const effectiveCap = rules.minRestPerWeekWindow ? Math.min(cap, 6) : cap;

    // A user-configured rule: if an employee's locked (연차 등 확정된) rest block runs at
    // least rules.longBreakDays days in a row, the consecutive-work cap around it is relaxed
    // to rules.extendedWorkCap for that person, for the whole month — a long break justifies
    // working a bit more before/after it. Falls back to the plain cap when unset.
    const personalCap = {};
    employees.forEach((emp) => {
      let personal = effectiveCap;
      if (rules.longBreakDays != null && rules.extendedWorkCap != null) {
        let longestLockedRun = 0;
        let run = 0;
        for (const date of dates) {
          if (Model.isBaseOff(emp, date)) {
            run++;
            longestLockedRun = Math.max(longestLockedRun, run);
          } else {
            run = 0;
          }
        }
        if (longestLockedRun >= rules.longBreakDays) personal = Math.max(effectiveCap, rules.extendedWorkCap);
      }
      personalCap[emp.id] = personal;
    });
    // 전달에서 이어받은 연속근무일수가 이번 달 개인 상한보다 크면(연장 상한이 이번 달엔 없는
    // 경우 등) 상한만큼으로 눌러준다 — "이미 상한에 닿아 있다"는 뜻으로 취급.
    employees.forEach((emp) => {
      consecutiveWork[emp.id] = Math.min(consecutiveWork[emp.id], personalCap[emp.id]);
    });

    const shiftMinTotal = (rules.minMorningStaff || 0) + (rules.minAfternoonStaff || 0);

    // cornerAllowedOff/cornerMinStaffGlobal are computed once in generateSchedule from ALL
    // employees store-wide (not just this group) — a corner like 기프트 can have members split
    // across departments (e.g. a 파트장 who also covers 기프트, routed into the 관리 group), so
    // the cap has to be shared across every group's Phase 1 fill and catch-up passes, or two
    // groups can each grant OFF to "their" share of the same corner without seeing each other.

    // Fairness group headcount: small sub-corners (e.g. 기프트/학용/필기구/디자인문구)
    // are pooled together per Model.cornerFairnessGroup so red-day rest is shared
    // across the whole pool rather than computed per tiny individual corner.
    const fairnessGroupTotal = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key) fairnessGroupTotal[key] = (fairnessGroupTotal[key] || 0) + 1;
      }
    });

    // Red-day (Sat/Sun/holiday) fairness: each employee should get an even share of
    // red-day OFF within their own corner, since red days are when the store needs
    // the most coverage and weekdays are when everyone rests anyway.
    const redDates = dates.filter((date) => Model.isWeekend(date) || Model.isRedDay(date));
    const lockedRedDayOffCount = {};
    employees.forEach((emp) => {
      lockedRedDayOffCount[emp.id] = 0;
    });
    for (const emp of employees) {
      for (const date of redDates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) lockedRedDayOffCount[emp.id]++;
      }
    }
    const fairnessRedDayOff = {};
    employees.forEach((emp) => { fairnessRedDayOff[emp.id] = 0; });
    const redDayTarget = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      let base;
      if (corners.length === 1) {
        const key = Model.cornerFairnessGroup(corners[0]);
        if (key && fairnessGroupTotal[key]) {
          base = redDates.length / fairnessGroupTotal[key];
        } else {
          base = redDates.length / n;
        }
      } else {
        base = redDates.length / n;
      }
      redDayTarget[emp.id] = Math.max(lockedRedDayOffCount[emp.id], base);
    });

    // Looks ahead: if `emp` keeps working every day from here on, their consecutive-work cap
    // will force them to rest on a specific future date. If a corner-mate already has locked
    // (BASE/MANUAL) leave on that exact future date, forcing `emp` to rest that same day would
    // empty the corner out — so today is a good day to give `emp` a voluntary rest instead,
    // which resets their streak and pushes the forced date past the collision.
    function forecastsForcedCollision(emp, dayIndex) {
      const daysUntilForced = personalCap[emp.id] - consecutiveWork[emp.id];
      if (daysUntilForced <= 0) return false;
      const forcedIdx = dayIndex + daysUntilForced;
      if (forcedIdx >= dates.length) return false;
      const forcedDate = dates[forcedIdx];
      const corners = Model.employeeCorners(emp);
      if (corners.length === 0) return false;
      return corners.some((c) => allEmployees.some((mate) => {
        if (mate.id === emp.id || !Model.employeeCorners(mate).includes(c)) return false;
        const cell = schedule[mate.id][forcedDate];
        return cell && cell.status === 'OFF' && (cell.source === 'BASE' || cell.source === 'MANUAL');
      }));
    }

    // Everyone starts the month with zero work history, so nobody looks "urgent" by the pacing
    // formula until the whole group hits the consecutive-work cap on the exact same day — by
    // then there's only reqRoom slots for however many hit it together, and the rest overflow the
    // cap no matter how the pacing is tuned. A person scheduling by hand would pre-empt this by
    // staggering a few people's first rest day early; this assigns each employee a deterministic
    // "cohort" day within the first effectiveCap+1 days so the group is already desynchronized by
    // the time the cap would otherwise be hit simultaneously. Only applies to whoever is still on
    // an unbroken from-day-1 streak when their cohort day arrives — anyone whose locked leave
    // already broke their streak earlier doesn't need the nudge.
    const earlyStaggerDay = {};
    employees.forEach((emp, idx) => {
      earlyStaggerDay[emp.id] = idx % (effectiveCap + 1);
    });
    function needsEarlyStagger(emp, dayIndex) {
      return dayIndex === earlyStaggerDay[emp.id] && consecutiveWork[emp.id] === dayIndex;
    }

    // Phase 1: chronological greedy fill
    // totalOffSoFar tracks the running sum of fairnessOff across all employees, used below to
    // pace daily rest slots against the target instead of against staffing headroom.
    let totalOffSoFar = 0;
    for (let dayIndex = 0; dayIndex < dates.length; dayIndex++) {
      const date = dates[dayIndex];
      const weekend = Model.isWeekend(date);
      const redDay = weekend || Model.isRedDay(date);
      const req = Math.max(Model.minStaffRequired(rules, date), shiftMinTotal);

      const lockedEmployees = [];
      const freeEmployees = [];
      for (const emp of employees) {
        if (isLocked(schedule, emp.id, date)) lockedEmployees.push(emp);
        else freeEmployees.push(emp);
      }
      const fixedOffCount = lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').length;

      if (n - fixedOffCount < req) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 고정/수동 휴무만으로 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
          employeeIds: lockedEmployees.filter((emp) => schedule[emp.id][date].status === 'OFF').map((e) => e.id)
        });
      }

      // How much rest today's own staffing minimum allows, before touching the monthly target
      // pacing at all — a day that genuinely needs full staffing shouldn't get emptied out just
      // because the month-wide rest quota has room, and a slack day (nobody on leave, more
      // people available than the minimum) should absorb extra rest rather than overstaffing.
      const allowedAdditionalOff = Math.max(0, n - req - fixedOffCount);

      // 강제휴무란 있을 수 없다(사장님 지시: "강제휴무란 있을 수 없어... 그럴 경우에는 최적으로
      // 나머지 휴무를 분배하고 길게 근무하는 경우 오류를 뜨게 해줘야해") — 연속근무 상한에
      // 닿은 사람을 이 날 무조건 쉬게 만들지 않는다. 대신 아래 candidates 정렬에서 연속근무일수가
      // 가장 긴 사람을 최우선으로 오늘의 재량휴무 후보로 올려서, 목표 휴무일수 예산 안에서
      // 최대한 상한을 지키도록 자연스럽게 유도한다. 그래도 예산이 부족해 상한을 넘기게 되는
      // 경우는 뒤의 enforceConsecutiveCap이 오류로 표시한다(억지로 쉬게 만들지 않음).
      //
      // Pace today's rest slots against the target trajectory (how much of totalTargetSum
      // "should" be used up by this point in the month). Normally capped by the day's own
      // staffing room (allowedAdditionalOff) so a fully-staffed day doesn't get overstaffed
      // and a low-staffing day doesn't get emptied for no reason — the target/staffing gap
      // that this creates gets caught up later by rebalanceDecoupled's escalated passes,
      // which are the ones allowed to actually dip below minimum staffing when unavoidable.
      const desiredCumulative = Math.round((totalTargetSum * (dayIndex + 1)) / dates.length);
      const paceSlots = Math.max(0, desiredCumulative - totalOffSoFar);
      const reqRoom = allowedAdditionalOff;
      // 최대 근무 인원(선택): 설정돼 있으면 오늘 근무 인원이 그 값을 넘지 않도록 최소 이만큼은
      // 무조건 쉬게 한다 — 목표 페이스/최소인원 여유와 무관하게 이 하한은 항상 지켜야 한다.
      const maxStaffAllowed = rules.maxStaffDefault;
      const requiredOffForMaxStaff = maxStaffAllowed != null
        ? Math.max(0, n - maxStaffAllowed - fixedOffCount)
        : 0;
      if (maxStaffAllowed != null && maxStaffAllowed < req) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 최대 근무 인원(${maxStaffAllowed}명)이 최소 근무 인원(${req}명)보다 적어 규칙이 서로 맞지 않습니다.`,
          employeeIds: []
        });
      }
      // 목표 페이스(paceSlots)는 한 달 전체에 걸쳐 고르게 퍼뜨리려는 값이라, 월초처럼 다 같이
      // 근무를 시작해서 여러 명이 동시에 상한에 닿는 날엔 너무 작을 수 있다 — 오늘 상한에 닿는
      // 인원(criticalCount)은 그 페이스보다 우선해서 반드시 슬롯을 확보해준다. 그래도 실제
      // 근무 가능 인원(reqRoom)이 부족하면 그건 진짜 물리적 한계라 오류로 남긴다.
      const criticalCount = freeEmployees.filter((emp) => consecutiveWork[emp.id] >= personalCap[emp.id]).length;
      if (criticalCount > reqRoom) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 연속 근무 상한에 닿은 인원(${criticalCount}명)이 오늘 쉴 수 있는 여유 인원(${reqRoom}명)보다 많아 일부는 상한을 넘겨 근무하게 됩니다.`,
          employeeIds: freeEmployees.filter((emp) => consecutiveWork[emp.id] >= personalCap[emp.id]).map((e) => e.id)
        });
      }
      const staggerNeedCount = freeEmployees.filter((emp) => needsEarlyStagger(emp, dayIndex)).length;
      const remainingSlots = Math.max(Math.min(paceSlots, reqRoom), requiredOffForMaxStaff, Math.min(criticalCount, reqRoom), Math.min(staggerNeedCount, reqRoom));
      const candidates = freeEmployees;

      // Per-corner OFF budget: same principle as the store-wide staffing room above — respect
      // each corner's own morning+afternoon minimum first when picking who rests today, and only
      // let the month-end catch-up passes (rebalanceDecoupled/trim) breach it as a last resort.
      // Scan ALL employees (not just this group) so a corner already emptied out by another
      // group's earlier pass (or by that other group's own locked/forced OFF today) is seen here.
      const cornerOffUsed = {};
      allEmployees.forEach((emp) => {
        const cell = schedule[emp.id][date];
        if (!cell || cell.status !== 'OFF') return;
        Model.employeeCorners(emp).forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
        });
      });
      // Corner shortfalls caused by locked/forced OFF alone are no longer reported here — a
      // later pass (backfillCornerShortfalls, run once at the very end of generateSchedule after
      // every group has been scheduled) tries to fix them first by pulling in a same-corner
      // AUTO_FAIRNESS rest day or a 파트장, and only reports the ones it genuinely can't fix.
      // A sibling department is already short-staffed on this date, so every 파트장 needs to stay
      // available for backfillPartLeaders rather than one of them taking rest here — block ANY
      // new 파트장 rest pick today (not just once the cap is reached), since backfillPartLeaders
      // will pull in whoever it can regardless of how many are already off, and every one Phase 1
      // adds here is one more that gets immediately reversed there. Applied only to the
      // candidate-blocking check below, after the real violation check above already ran, so this
      // synthetic block doesn't itself get misreported as a corner-minimum violation.
      if (excludeDatesForSlack && excludeDatesForSlack.has(date) && cornerAllowedOff['파트장'] != null) {
        cornerOffUsed['파트장'] = Infinity;
      }

      // 기본 근무 텀은 2~3일에 하루 휴무 — 4~5일 연속 근무는 정말 어쩔 수 없을 때만(사장님 지시:
      // "이게 기본이니까 기억해둬"). 그래서 오늘 쉴 사람을 고를 때 현재 연속근무일수를 목표
      // 휴무일수 편차보다 먼저 본다 — 매번 상한(4일)까지 꽉 채워 일하다 강제휴무로만 쉬는 패턴이
      // 아니라, 이미 며칠 일한 사람부터 우선적으로 쉬게 해서 짧고 잦은 휴무가 기본값이 되게 한다.
      candidates.sort((a, b) => {
        const staggerA = needsEarlyStagger(a, dayIndex) ? 1 : 0;
        const staggerB = needsEarlyStagger(b, dayIndex) ? 1 : 0;
        if (staggerA !== staggerB) return staggerB - staggerA;
        const collideA = forecastsForcedCollision(a, dayIndex) ? 1 : 0;
        const collideB = forecastsForcedCollision(b, dayIndex) ? 1 : 0;
        if (collideA !== collideB) return collideB - collideA;
        if (redDay) {
          const redDeficitA = redDayTarget[a.id] - fairnessRedDayOff[a.id];
          const redDeficitB = redDayTarget[b.id] - fairnessRedDayOff[b.id];
          if (redDeficitB !== redDeficitA) return redDeficitB - redDeficitA;
        }
        if (consecutiveWork[b.id] !== consecutiveWork[a.id]) return consecutiveWork[b.id] - consecutiveWork[a.id];
        const deficitA = target[a.id] - fairnessOff[a.id];
        const deficitB = target[b.id] - fairnessOff[b.id];
        if (deficitB !== deficitA) return deficitB - deficitA;
        if (weekend) {
          const wDiff = weekendOff[a.id] - weekendOff[b.id];
          if (wDiff !== 0) return wDiff;
        }
        return employees.indexOf(a) - employees.indexOf(b);
      });

      const chosenOff = [];
      for (const emp of candidates) {
        if (chosenOff.length >= remainingSlots) break;
        // On red days, once someone has already taken their fair share of red-day rest,
        // leave them working rather than filling every allowed slot with rest -- red days
        // are meant to be mostly worked, only rotated rest per corner.
        if (redDay && fairnessRedDayOff[emp.id] >= Math.ceil(redDayTarget[emp.id])) continue;
        const empCorners = Model.employeeCorners(emp);
        const blocked = empCorners.some((c) => cornerSmoothCap[c] != null && (cornerOffUsed[c] || 0) >= cornerSmoothCap[c]);
        if (blocked) continue;
        chosenOff.push(emp);
        empCorners.forEach((c) => {
          cornerOffUsed[c] = (cornerOffUsed[c] || 0) + 1;
        });
      }
      const chosenOffIds = new Set(chosenOff.map((e) => e.id));

      if (maxStaffAllowed != null && chosenOff.length < requiredOffForMaxStaff) {
        conflicts.push({
          date,
          type: 'MIN_STAFF_VIOLATION',
          message: `${date}: 최대 근무 인원(${maxStaffAllowed}명)을 지키려면 더 쉬어야 하지만, 코너 최소 인원 등 다른 제약 때문에 다 쉴 수 없습니다.`,
          employeeIds: []
        });
      }

      candidates.filter((emp) => chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'OFF', 'AUTO_FAIRNESS'));
      candidates.filter((emp) => !chosenOffIds.has(emp.id)).forEach((emp) => setCell(schedule, emp.id, date, 'WORK', 'AUTO'));

      for (const emp of employees) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF') {
          consecutiveWork[emp.id] = 0;
          totalOff[emp.id]++;
          if (weekend) weekendOff[emp.id]++;
          if (redDay) redDayOff[emp.id]++;
          if (!isExemptLockedOff(emp, date, schedule)) {
            fairnessOff[emp.id]++;
            totalOffSoFar++;
            if (redDay) fairnessRedDayOff[emp.id]++;
          }
        } else {
          consecutiveWork[emp.id]++;
        }
      }
    }

    rebalanceRedDays(schedule, employees, allEmployees, redDates, dates, personalCap, cornerAllowedOff, fairnessRedDayOff, conflicts);
    // Recompute weekdayOff straight from the schedule (not by subtracting fairnessRedDayOff
    // from the pre-rebalance fairnessOff) — rebalanceRedDays just swapped OFF/WORK cells on
    // red days, so that subtraction would use a stale fairnessOff and desync from reality.
    const weekdayDates = dates.filter((date) => !(Model.isWeekend(date) || Model.isRedDay(date)));
    const weekdayOff = {};
    employees.forEach((emp) => {
      let count = 0;
      for (const date of weekdayDates) {
        const cell = schedule[emp.id][date];
        if (cell.status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      weekdayOff[emp.id] = count;
    });
    rebalance(schedule, employees, allEmployees, weekdayDates, dates, personalCap, cornerAllowedOff, weekdayOff, conflicts, true);

    // rebalance() above only trades OFF/WORK on the *same date* between two people, which stays
    // staffing-neutral for that day but can leave gaps unfixed simply because the two people who
    // need to trade never happen to have opposite status on the same date. Since the target
    // off-days count outranks staffing (사장님 지시), run one more pass that decouples the swap —
    // take a rest day off the highest person on whatever date works for them, and give a rest day
    // to the lowest person on whatever date works for them, independently. This reaches every
    // fixable gap the paired swaps couldn't, at the cost of possibly dipping staffing further on
    // the lowest person's chosen date (already flagged only informationally, not blocked).
    const monthOff = {};
    employees.forEach((emp) => {
      let count = 0;
      for (const date of dates) {
        if (schedule[emp.id][date].status === 'OFF' && !isExemptLockedOff(emp, date, schedule)) count++;
      }
      monthOff[emp.id] = count;
    });
    rebalanceDecoupled(schedule, employees, allEmployees, dates, personalCap, cornerAllowedOff, monthOff, target, conflicts, excludeDatesForSlack, rules.maxStaffDefault);

    // rebalanceDecoupled only ever moves a day from someone OVER target to someone UNDER — if a
    // corner's shared cap is scarce enough that EVERYONE in it stays under target (e.g. 파트장:
    // only 1 of 4 can rest per day, so the group can't reach 9 each even at full capacity), there's
    // never an "over" person to take a day from, so leftover unused slack (a day nobody in that
    // corner is resting on, even though the cap would allow one more) just sits unused instead of
    // going to whoever's fallen furthest behind their corner-mates. This pass spends exactly that
    // leftover slack, evening the group out as far as the shared cap allows.
    fillCornerSlack(schedule, employees, allEmployees, dates, cornerAllowedOff, monthOff, target, excludeDatesForSlack);

    // 목표 휴무일수가 실제로 지켜졌는지는 이 시점이 아니라 generateSchedule 맨 마지막의
    // enforceTargetOffDays에서 최종적으로 강제/확인한다 — 그 전까지는 다른 그룹의 backfill 등
    // 이후 패스가 이 값을 더 바꿀 수 있어서, 여기서 미리 "못 맞췄다"고 알리면 나중에 실제로는
    // 맞춰졌는데도 오래된 알림이 남아 헷갈릴 수 있다.
    return { target, personalCap };
  }

  // 파트장 backfill: for any date where a department's own dedicated staff can't meet its
  // minimum staffing (a MIN_STAFF_VIOLATION was recorded for that dept's own people), pull in
  // an available 파트장 (currently resting, not BASE/MANUAL locked) to cover the gap. This runs
  // after every department/관리 group has already been scheduled independently.

  // 강제휴무란 있을 수 없다(사장님 지시) — 연속근무 상한에 닿아도 스케줄러가 억지로 쉬게
  // 만들지 않는다. 대신 목표 휴무일수 예산(Phase 1의 우선순위 배정 + enforceTargetOffDays)만으로
  // 상한을 지킬 수 없었던 경우를 여기서 최종적으로 찾아내 오류로 표시한다 — 스케줄 자체는
  // 손대지 않고, 실제로 상한을 넘긴 연속근무 구간을 있는 그대로 보고한다.
  function detectConsecutiveCapViolations(schedule, employees, dates, personalCapByEmpId, conflicts) {
    employees.forEach((emp) => {
      const cap = personalCapByEmpId[emp.id];
      if (cap == null) return;
      let streak = 0;
      let streakStart = null;
      for (const date of dates) {
        const cell = schedule[emp.id][date];
        if (cell && cell.status === 'WORK') {
          if (streak === 0) streakStart = date;
          streak++;
          if (streak === cap + 1) {
            conflicts.push({
              date,
              type: 'MIN_STAFF_VIOLATION',
              message: `${date}: ${emp.name}님이 ${streakStart}부터 연속 근무 중이며 상한(${cap}일)을 넘겼습니다. 목표 휴무일수 예산만으로는 이 상한을 지킬 수 없는 경우입니다.`,
              employeeIds: [emp.id]
            });
          }
        } else {
          streak = 0;
          streakStart = null;
        }
      }
    });
  }

  // Absolute last resort for the one rule that must never lose to anything else: everyone's
  // target off-days count is matched EXACTLY, not just "at least" (사장님 지시: "최우선은 목표
  // 휴무일수야. 최우선이라고 정하고 무조건 목표 휴무일 수에 맞춰. 그 다음 틀어지는 결과는
  // 오류에 뜨게 만들어줘"). Every earlier pass can leave someone either under target (a corner
  // with no spare capacity at all, e.g. a corner down to one member who must always work) or over
  // it (fillCornerSlack/rebalanceDecoupled spend leftover slack as bonus rest with no upper
  // bound). This pass is the final word: it fills any deficit AND trims any surplus down to
  // exactly target, breaking corner staffing minimums or even the consecutive-work cap if that's
  // what it takes — but every time it does, it flags exactly which rule and day paid the price,
  // so nothing breaks silently.
  function enforceTargetOffDays(schedule, employees, dates, targetByEmpId, cornerMinStaffGlobal, personalCap, conflicts) {
    function cornerWorkingWithout(emp, date) {
      return Model.employeeCorners(emp).every((c) => {
        const need = cornerMinStaffGlobal[c];
        if (!need) return true;
        const working = employees.filter((e) => e.id !== emp.id && Model.employeeCorners(e).includes(c) && schedule[e.id][date].status === 'WORK').length;
        return working >= need;
      });
    }

    employees.forEach((emp) => {
      const target = targetByEmpId[emp.id];
      if (target == null) return;
      let offCount = 0;
      dates.forEach((d) => {
        if (schedule[emp.id][d].status === 'OFF' && !isExemptLockedOff(emp, d, schedule)) offCount++;
      });
      const roundedTarget = Math.round(target);
      let deficit = roundedTarget - offCount;
      if (deficit === 0) return;

      if (deficit > 0) {
        const candidates = dates.filter((d) => schedule[emp.id][d].status === 'WORK' && schedule[emp.id][d].source === 'AUTO');
        candidates.sort((a, b) => (cornerWorkingWithout(emp, a) ? 0 : 1) - (cornerWorkingWithout(emp, b) ? 0 : 1));

        for (const d of candidates) {
          if (deficit <= 0) break;
          const safeCornerToday = cornerWorkingWithout(emp, d);
          setCell(schedule, emp.id, d, 'OFF', 'AUTO_FAIRNESS');
          deficit--;
          if (!safeCornerToday) {
            conflicts.push({
              date: d,
              type: 'CORNER_MIN_STAFF_VIOLATION',
              message: `${d}: ${emp.name}님의 목표 휴무일수를 맞추기 위해 근무를 휴무로 바꿨는데, 이 날 소속 코너 최소 인원이 채워지지 않습니다.`,
              employeeIds: [emp.id]
            });
          }
        }

        if (deficit > 0) {
          conflicts.push({
            date: null,
            type: 'IMBALANCE_NOTICE',
            message: `${emp.name}님은 목표 휴무일수(${target}일)를 다 채우지 못했습니다 — 휴무로 바꿀 수 있는 근무일 자체가 부족합니다.`,
            employeeIds: [emp.id]
          });
        }
        return;
      }

      // 목표보다 더 쉬고 있으면(다른 패스가 남는 여유를 보너스 휴무로 써버린 경우), 그 초과분을
      // 근무로 되돌려 정확히 목표에 맞춘다. 확정 휴무(BASE/MANUAL)는 절대 건드리지 않고, 재량
      // 휴무(AUTO_FAIRNESS)만 대상으로 한다. 상한을 안 넘기는 날부터 우선 고르되, 그래도 상한을
      // 넘기게 되면 그냥 넘긴다 — 결과는 뒤의 detectConsecutiveCapViolations가 오류로 잡아낸다
      // (사장님 지시: "강제휴무란 있을 수 없어... 길게 근무하는 경우 오류를 뜨게 해줘야해").
      let surplus = -deficit;
      const surplusCandidates = dates.filter((d) => schedule[emp.id][d].status === 'OFF' && schedule[emp.id][d].source === 'AUTO_FAIRNESS');
      surplusCandidates.sort((a, b) => (wouldSwapBreakCap(emp, a, a, dates, schedule, personalCap) ? 1 : 0) - (wouldSwapBreakCap(emp, b, b, dates, schedule, personalCap) ? 1 : 0));

      for (const d of surplusCandidates) {
        if (surplus <= 0) break;
        setCell(schedule, emp.id, d, 'WORK', 'AUTO');
        surplus--;
      }

      if (surplus > 0) {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `${emp.name}님은 목표 휴무일수(${target}일)보다 ${surplus}일 더 쉬고 있는데, 확정 휴무/강제 휴무라 근무로 되돌릴 수 없습니다.`,
          employeeIds: [emp.id]
        });
      }
    });
  }

  // 매달 최소 한 번은 이틀 이상 연속 휴무가 있어야 한다. 목표 휴무일수 총량은 절대 바꾸지
  // 않고(넘버원 원칙), 이미 배정된 재량 휴무(AUTO_FAIRNESS) 하나를 다른 휴무 바로 옆 날짜로
  // "옮겨서" 붙인다 — 그 날짜가 원래 근무일이었으면 이 사람은 그날 근무로, 대신 그 옆 날은
  // 휴무로 바뀌는 식이라 총 휴무일수는 그대로다. BASE/MANUAL(연차·개인휴무 등 확정 휴무)은
  // 옮기지 않는다 — 확정된 휴무를 건드리면 안 된다는 원칙과 같다. 옮길 곳이 전혀 없으면(코너
  // 최소인원이 항상 걸리는 등) 오류로 표시하고 넘어간다(사장님 지시: "도저히 근무를 못
  // 맞추겠으면 오류로 하자").
  function enforceBackToBackRest(schedule, employees, dates, cornerMinStaffGlobal, conflicts) {
    function cornerWorkingWithout(emp, date) {
      return Model.employeeCorners(emp).every((c) => {
        const need = cornerMinStaffGlobal[c];
        if (!need) return true;
        const working = employees.filter((e) => e.id !== emp.id && Model.employeeCorners(e).includes(c) && schedule[e.id][date].status === 'WORK').length;
        return working >= need;
      });
    }

    employees.forEach((emp) => {
      const empSchedule = schedule[emp.id];
      const offDates = dates.filter((d) => empSchedule[d].status === 'OFF');
      if (offDates.length < 2) {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `${emp.name}님은 이번 달 휴무일수가 너무 적어 이틀 이상 연속 휴무를 만들 수 없습니다.`,
          employeeIds: [emp.id]
        });
        return;
      }
      const offSet = new Set(offDates);
      const hasBlock = dates.some((d, i) => i < dates.length - 1 && offSet.has(d) && offSet.has(dates[i + 1]));
      if (hasBlock) return;

      let fixed = false;
      for (const sourceDate of offDates) {
        if (fixed) break;
        if (empSchedule[sourceDate].source !== 'AUTO_FAIRNESS') continue;
        for (const anchorDate of offDates) {
          if (fixed || anchorDate === sourceDate) continue;
          const anchorIdx = dates.indexOf(anchorDate);
          for (const neighborIdx of [anchorIdx - 1, anchorIdx + 1]) {
            if (neighborIdx < 0 || neighborIdx >= dates.length) continue;
            const neighborDate = dates[neighborIdx];
            if (offSet.has(neighborDate) || neighborDate === sourceDate) continue;
            const neighborCell = empSchedule[neighborDate];
            if (neighborCell.status !== 'WORK' || neighborCell.source !== 'AUTO') continue;
            if (!cornerWorkingWithout(emp, neighborDate)) continue;
            setCell(schedule, emp.id, sourceDate, 'WORK', 'AUTO');
            setCell(schedule, emp.id, neighborDate, 'OFF', 'AUTO_FAIRNESS');
            fixed = true;
            break;
          }
        }
      }

      if (!fixed) {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `${emp.name}님은 이번 달 이틀 이상 연속 휴무를 만들 수 없습니다 — 다른 필수 조건 때문에 휴무를 옮길 자리가 없습니다.`,
          employeeIds: [emp.id]
        });
      }
    });
  }

  // Runs once at the very end, after every department/관리 group and backfillPartLeaders have
  // already been scheduled. Some corners (기프트/문보장 등) can end up short of their own
  // morning+afternoon minimum purely from locked leave + consecutive-cap forced rest landing on
  // the same day — this fixes that by (1) first trying to pull a same-corner AUTO_FAIRNESS rest
  // day back to WORK, and only if that's not enough, (2) pulling in a 파트장 as floating coverage
  // (사장님 지시: "파트장님을 투입하는걸로 하는데 최대한 직원들 안에서 해결해야해"). Both steps
  // only ever touch someone who is already resting MORE than their own guaranteed target
  // off-days count, so nobody's guaranteed rest gets sacrificed for staffing.
  // Would swapping emp's status between fromDate (OFF -> WORK) and toDate (WORK -> OFF) push
  // any run of consecutive workdays past emp's personal cap, anywhere in the month? Checked by
  // simulating the swap over the whole month rather than just the two affected days, since a
  // short gap between fromDate and toDate can chain two runs together.
  function wouldSwapBreakCap(emp, fromDate, toDate, dates, schedule, personalCap) {
    let maxRun = 0;
    let run = 0;
    for (const d of dates) {
      let status = schedule[emp.id][d].status;
      if (d === fromDate) status = 'WORK';
      else if (d === toDate) status = 'OFF';
      if (status === 'WORK') {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    return maxRun > personalCap[emp.id];
  }

  // Finds a plan (a chain of one or more { emp, fromDate, toDate } moves) that lets `emp` take
  // the rest day they're currently taking on `fromDate` on some other date instead, without
  // breaking anyone's consecutive-work cap or dropping any corner below its minimum. Each move
  // only relocates WHICH day someone rests, never how MANY days total, so nobody's guaranteed
  // target off-days count is ever put at risk — unlike cancelling a rest day outright, this is
  // always safe to attempt.
  //
  // A single relocation can fail purely because every otherwise-valid destination day already
  // has a different corner-mate resting there (corners this tight only ever allow one person off
  // per day) — the classic "musical chairs" case. So when a candidate destination is blocked by
  // exactly one such colleague, this recurses to try relocating THAT colleague off that date
  // first (bounded by `depth`), chaining several small moves together to open up a slot that no
  // single direct move could reach. Apply the returned plan in reverse order (innermost move
  // first) so each move's pre-conditions still hold when it's actually applied.
  function findRelocationDate(schedule, emp, fromDate, dates, personalCap, cornerMinStaffGlobal, allEmployees, avoid, depth) {
    avoid = avoid || new Set([emp.id + '|' + fromDate]);
    depth = depth == null ? 1 : depth;
    const corners = Model.employeeCorners(emp);
    if (corners.length === 0) return null;

    function cornerGapsWithoutEmp(date) {
      const gaps = [];
      corners.forEach((c) => {
        const need = cornerMinStaffGlobal[c];
        if (!need) return;
        const working = allEmployees.filter((e) => e.id !== emp.id && Model.employeeCorners(e).includes(c) && schedule[e.id][date].status === 'WORK').length;
        if (working < need) gaps.push({ corner: c, deficit: need - working });
      });
      return gaps;
    }

    const fromIdx = dates.indexOf(fromDate);
    const order = [];
    for (let d = 1; d < dates.length; d++) {
      if (fromIdx + d < dates.length) order.push(fromIdx + d);
      if (fromIdx - d >= 0) order.push(fromIdx - d);
    }

    for (const idx of order) {
      const toDate = dates[idx];
      const cell = schedule[emp.id][toDate];
      if (cell.status !== 'WORK' || cell.source !== 'AUTO') continue;
      if (wouldSwapBreakCap(emp, fromDate, toDate, dates, schedule, personalCap)) continue;

      const gaps = cornerGapsWithoutEmp(toDate);
      if (gaps.length === 0) return [{ emp, fromDate, toDate }];
      if (depth <= 0 || gaps.length > 1 || gaps[0].deficit !== 1) continue;

      const blockers = allEmployees.filter((e) => {
        if (e.id === emp.id || avoid.has(e.id + '|' + toDate)) return false;
        if (!Model.employeeCorners(e).includes(gaps[0].corner)) return false;
        const c = schedule[e.id][toDate];
        return c.status === 'OFF' && (c.source === 'AUTO_FAIRNESS' || c.source === 'AUTO_FORCED');
      });
      for (const blocker of blockers) {
        const nextAvoid = new Set(avoid);
        nextAvoid.add(blocker.id + '|' + toDate);
        const subPlan = findRelocationDate(schedule, blocker, toDate, dates, personalCap, cornerMinStaffGlobal, allEmployees, nextAvoid, depth - 1);
        if (subPlan) return [{ emp, fromDate, toDate }, ...subPlan];
      }
    }
    return null;
  }

  function applyRelocationPlan(schedule, plan) {
    for (let i = plan.length - 1; i >= 0; i--) {
      const { emp, fromDate, toDate } = plan[i];
      const source = schedule[emp.id][fromDate].source;
      setCell(schedule, emp.id, fromDate, 'WORK', 'AUTO');
      setCell(schedule, emp.id, toDate, 'OFF', source);
    }
  }

  // Runs once at the very end, after every department/관리 group and backfillPartLeaders have
  // already been scheduled. Some corners (기프트/문보장 등) can end up short of their own
  // morning+afternoon minimum purely from locked leave + consecutive-cap forced rest landing on
  // the same day. Fixes it by relocating someone's rest day to a different date rather than
  // cancelling it outright — first a same-corner member's, then (as floating coverage) a
  // 파트장's — which preserves everyone's total off-day count exactly, so nobody's guaranteed
  // rest is ever sacrificed for staffing (사장님 지시: "파트장님을 투입하는걸로 하는데 최대한
  // 직원들 안에서 해결해야해").
  // 문보장은 별개 코너라 다른 파트의 도움을 주지도, 받지도 않는다(사장님 지시: "문보장은
  // 별개라 문보장 인원으로 채우면 안돼") — 그 외 코너(기프트/학용/필기구/디자인문구)는 서로
  // 급할 때 임시로 지원할 수 있다.
  const LEND_ISOLATED_CORNERS = { '문보장': true };

  function backfillCornerShortfalls(schedule, employees, dates, cornerMinStaffGlobal, personalCap, conflicts) {
    const partLeaders = employees.filter((emp) => Model.employeeCorners(emp).includes('파트장'));
    const partLeaderMin = cornerMinStaffGlobal['파트장'] || 0;
    const corners = Object.keys(cornerMinStaffGlobal).filter((c) => c !== '파트장');
    const relocatable = (cell) => cell.status === 'OFF' && (cell.source === 'AUTO_FAIRNESS' || cell.source === 'AUTO_FORCED');

    for (const date of dates) {
      for (const corner of corners) {
        const need = cornerMinStaffGlobal[corner];
        if (!need) continue;
        const members = employees.filter((emp) => Model.employeeCorners(emp).includes(corner));
        let shortfall = need - members.filter((emp) => schedule[emp.id][date].status === 'WORK').length;
        if (shortfall <= 0) continue;

        const sameCornerCandidates = members.filter((emp) => relocatable(schedule[emp.id][date]));
        for (const emp of sameCornerCandidates) {
          if (shortfall <= 0) break;
          const plan = findRelocationDate(schedule, emp, date, dates, personalCap, cornerMinStaffGlobal, employees);
          if (!plan) continue;
          applyRelocationPlan(schedule, plan);
          shortfall--;
        }
        if (shortfall <= 0) continue;

        // 파트장 already working beyond their own daily minimum are free floating coverage —
        // count that slack toward this corner's gap before relocating anyone else's rest.
        const workingPartLeadersToday = partLeaders.filter((emp) => schedule[emp.id][date].status === 'WORK').length;
        shortfall -= Math.min(shortfall, Math.max(0, workingPartLeadersToday - partLeaderMin));
        if (shortfall <= 0) continue;

        const offPartLeaders = partLeaders.filter((emp) => relocatable(schedule[emp.id][date]));
        for (const emp of offPartLeaders) {
          if (shortfall <= 0) break;
          const plan = findRelocationDate(schedule, emp, date, dates, personalCap, cornerMinStaffGlobal, employees);
          if (!plan) continue;
          applyRelocationPlan(schedule, plan);
          shortfall--;
        }
        if (shortfall <= 0) continue;

        // 다른 파트(문보장 제외) 지원: 문보장이 아닌 다른 코너 소속 직원 중 재량휴무/강제휴무로
        // 쉬고 있는 사람을 임시로 투입한다.
        if (!LEND_ISOLATED_CORNERS[corner]) {
          const lenders = employees.filter((emp) =>
            !Model.employeeCorners(emp).includes(corner) &&
            !Model.employeeCorners(emp).some((c) => LEND_ISOLATED_CORNERS[c]) &&
            relocatable(schedule[emp.id][date])
          );
          for (const emp of lenders) {
            if (shortfall <= 0) break;
            const plan = findRelocationDate(schedule, emp, date, dates, personalCap, cornerMinStaffGlobal, employees);
            if (!plan) continue;
            applyRelocationPlan(schedule, plan);
            shortfall--;
          }
        }

        // 기프트는 오전1+오후1을 목표로 하되, 모든 지원 수단을 다 써도 안 되면 최소 1명만
        // 근무해도 괜찮다는 게 실제 기준이다(사장님 지시: "기프트는 한명은 무조건 하루에
        // 근무한다는 조건이야"). 다른 코너는 need 전체를 그대로 하드 요건으로 유지한다.
        const hardFloor = corner === '기프트' ? 1 : need;
        const workingNow = members.filter((emp) => schedule[emp.id][date].status === 'WORK').length;
        if (shortfall > 0 && workingNow < hardFloor) {
          conflicts.push({
            date,
            type: 'CORNER_MIN_STAFF_VIOLATION',
            message: `${date}: '${corner}' 코너 최소 인원(${need}명)을 다른 직원 조정과 파트장 투입만으로도 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      }
    }
  }

  function backfillPartLeaders(schedule, employees, deptEmployees, deptRules, rules, dates, conflicts, targetByEmpId) {
    const partLeaders = employees.filter((emp) => Model.employeeCorners(emp).includes('파트장'));
    if (partLeaders.length === 0) return;

    // Track each leader's remaining OFF-day count (as already finalized by their own group's
    // scheduling pass) and always pull from whoever currently has the MOST rest days left when
    // a shortfall needs covering — otherwise a fixed iteration order always favors pulling the
    // same person first, unevenly stripping their target off-days over the month.
    const offRemaining = {};
    partLeaders.forEach((leader) => {
      offRemaining[leader.id] = dates.filter((d) => schedule[leader.id][d].status === 'OFF').length;
    });

    ['문구', '서적'].forEach((dept) => {
      const deptEmps = deptEmployees[dept];
      if (deptEmps.length === 0) return;
      const groupRules = Object.assign({}, rules, deptRules[dept] || {});

      dates.forEach((date) => {
        const req = Math.max(Model.minStaffRequired(groupRules, date), (groupRules.minMorningStaff || 0) + (groupRules.minAfternoonStaff || 0));
        let working = deptEmps.filter((e) => schedule[e.id][date].status === 'WORK').length;
        if (working >= req) return;

        // AUTO_FORCED is a hard consecutive-work-cap rest day, not a discretionary fairness one —
        // pulling it back to WORK would push that person past their cap, which is exactly the
        // real-world limit this exists to prevent (사장님 지시: "연속근무제한이 왜 문제라는거니 ...
        // 무조건 휴무가 먼저"). Only BASE/MANUAL were excluded before; AUTO_FORCED must be too.
        // And even among the rest: only pull someone who's currently sitting ABOVE their own
        // target off-days count — target is a legal minimum (법정 휴무: 빨간날/공휴일 + 이미 쓴
        // 연차·체단·인정), not a suggestion, so staffing a department can never be allowed to
        // shave it down. If nobody has spare days above target, this date's shortfall goes
        // unfilled and gets reported below instead.
        const availableLeaders = partLeaders
          .filter((leader) => {
            const cell = schedule[leader.id][date];
            if (cell.status !== 'OFF' || cell.source === 'BASE' || cell.source === 'MANUAL' || cell.source === 'AUTO_FORCED') return false;
            const target = targetByEmpId ? targetByEmpId[leader.id] : undefined;
            if (target != null && offRemaining[leader.id] <= target) return false;
            return true;
          })
          .sort((a, b) => offRemaining[b.id] - offRemaining[a.id]);

        for (const leader of availableLeaders) {
          if (working >= req) break;
          setCell(schedule, leader.id, date, 'WORK', 'AUTO');
          offRemaining[leader.id]--;
          working++;
        }

        if (working < req) {
          conflicts.push({
            date,
            type: 'MIN_STAFF_VIOLATION',
            message: `${date}: 파트장 투입에도 '${dept}' 최소 근무 인원(${req}명)을 채울 수 없습니다.`,
            employeeIds: []
          });
        }
      });
    });

    if (partLeaders.length > 1) {
      let maxOff = -Infinity;
      let minOff = Infinity;
      partLeaders.forEach((leader) => {
        maxOff = Math.max(maxOff, offRemaining[leader.id]);
        minOff = Math.min(minOff, offRemaining[leader.id]);
      });
      if (maxOff - minOff > 1) {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `파트장은 항상 최소 1명은 근무해야 한다는 제약과 부서 최소 인원 보충 때문에, 휴무일수를 파트장끼리 완전히 고르게 나누지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
          employeeIds: []
        });
      }
    }
  }

  // Some employees prefer the "짧은 근무" shift right at the edge of a rest day: morning shift
  // on the day right before they're off (so their afternoon is already free), and afternoon
  // shift on the day right after returning from off (a lighter re-entry than an early morning).
  // Returns -1 (wants morning), 1 (wants afternoon), or 0 (no preference / not applicable).
  function edgeShiftPreference(emp, date, dates, schedule) {
    if (!emp.edgeShiftPreference) return 0;
    const idx = dates.indexOf(date);
    const nextDate = dates[idx + 1];
    const prevDate = dates[idx - 1];
    const nextOff = nextDate && schedule[emp.id][nextDate] && schedule[emp.id][nextDate].status === 'OFF';
    const prevOff = prevDate && schedule[emp.id][prevDate] && schedule[emp.id][prevDate].status === 'OFF';
    if (nextOff && !prevOff) return -1;
    if (prevOff && !nextOff) return 1;
    return 0;
  }

  // "퐁당퐁당" 방지: 근무일이 이어질 때 전-후-전-후처럼 매일 근무조가 바뀌면 힘들다는 사장님
  // 지시 — rules.avoidAlternatingShift가 켜져 있으면 어제도 근무했던 사람은 오늘도 어제와 같은
  // 조를 우선 배정해서, 같은 조로 몰아 근무하는 흐름을 만든다. 어제 쉬었거나(연속 근무 시작일)
  // 어제 조가 안 정해졌으면 이 규칙은 관여하지 않는다.
  function shiftContinuityPreference(emp, date, dates, schedule, rules) {
    if (!rules.avoidAlternatingShift) return 0;
    const idx = dates.indexOf(date);
    const prevDate = dates[idx - 1];
    if (!prevDate) return 0;
    const prevCell = schedule[emp.id][prevDate];
    if (!prevCell || prevCell.status !== 'WORK' || !prevCell.shift) return 0;
    return prevCell.shift === 'MORNING' ? -1 : 1;
  }

  // Edge-of-rest-day preference (opt-in per employee) wins when it applies; otherwise fall back
  // to the 퐁당퐁당-avoidance continuity preference (store-wide rule) when that's enabled.
  function shiftBias(emp, date, dates, schedule, rules) {
    const edge = edgeShiftPreference(emp, date, dates, schedule);
    if (edge !== 0) return edge;
    return shiftContinuityPreference(emp, date, dates, schedule, rules);
  }

  function assignShifts(schedule, employees, dates, rules, conflicts) {
    const minMorning = rules.minMorningStaff || 0;
    const minAfternoon = rules.minAfternoonStaff || 0;
    const deptRules = rules.deptRules || {};
    const hasDeptShiftReq = Object.values(deptRules).some((dr) =>
      (dr.minMorningStaff || 0) > 0 || (dr.minAfternoonStaff || 0) > 0 || dr.maxMorningStaff != null
    );
    const cornerShiftMin = rules.minStaffByCorner || {};
    const hasCornerShiftReq = Object.values(cornerShiftMin).some((req) => (req.morning || 0) > 0 || (req.afternoon || 0) > 0);
    const hasEdgePreference = employees.some((e) => e.edgeShiftPreference);
    if (minMorning === 0 && minAfternoon === 0 && !hasDeptShiftReq && !hasCornerShiftReq && !hasEdgePreference && !rules.avoidAlternatingShift && !employees.some((e) => e.shiftPreference !== 'ANY')) {
      return;
    }

    const morningCount = {};
    const afternoonCount = {};
    employees.forEach((e) => {
      morningCount[e.id] = 0;
      afternoonCount[e.id] = 0;
    });

    for (const date of dates) {
      const workingToday = employees.filter((e) => schedule[e.id][date] && schedule[e.id][date].status === 'WORK');

      const lockedMorning = [];
      const lockedAfternoon = [];
      let flexible = [];

      for (const e of workingToday) {
        const cell = schedule[e.id][date];
        if (cell.source === 'MANUAL' && cell.shift) {
          if (cell.shift === 'MORNING') lockedMorning.push(e);
          else lockedAfternoon.push(e);
        } else if (e.shiftPreference === 'MORNING') {
          lockedMorning.push(e);
        } else if (e.shiftPreference === 'AFTERNOON') {
          lockedAfternoon.push(e);
        } else {
          flexible.push(e);
        }
      }

      const byMorningNeedAsc = (a, b) =>
        (morningCount[a.id] - afternoonCount[a.id]) - (morningCount[b.id] - afternoonCount[b.id]);

      // Edge-of-rest-day preference takes priority over the plain morning/afternoon balance
      // when picking among the flexible pool (not the hard corner-minimum picks above), since
      // it's a "웬만하면" soft preference the employee opted into, not a hard requirement.
      const byMorningPreferenceThenNeed = (a, b) => {
        const prefDiff = shiftBias(a, date, dates, schedule, rules) - shiftBias(b, date, dates, schedule, rules);
        if (prefDiff !== 0) return prefDiff;
        return byMorningNeedAsc(a, b);
      };
      const byAfternoonPreferenceThenNeed = (a, b) => {
        const prefDiff = shiftBias(b, date, dates, schedule, rules) - shiftBias(a, date, dates, schedule, rules);
        if (prefDiff !== 0) return prefDiff;
        return byMorningNeedAsc(b, a);
      };

      // Corner-level minimums are satisfied first, pulling from that corner's flexible pool only
      Object.entries(cornerShiftMin).forEach(([corner, req]) => {
        let needM = req.morning || 0;
        let needA = req.afternoon || 0;
        if (needM === 0 && needA === 0) return;
        const cornerWorking = workingToday.filter((e) => Model.employeeCorners(e).includes(corner));
        const cornerLockedM = lockedMorning.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerLockedA = lockedAfternoon.filter((e) => Model.employeeCorners(e).includes(corner)).length;
        const cornerFlexible = flexible.filter((e) => Model.employeeCorners(e).includes(corner));

        // 문보장은 오후에 손님이 더 많아서, 셋이 다 근무하는 날은 2명을 오후로 몰아준다
        // (기본 오전1/오후1 최소치보다 더 필요할 때만 발동 — 인원이 3명 미만이면 그대로).
        if (corner === '문보장' && cornerWorking.length >= 3) {
          needA = Math.max(needA, 2);
        }

        const remainM = Math.max(0, needM - cornerLockedM);
        const remainA = Math.max(0, needA - cornerLockedA);

        // 기프트는 오전1+오후1을 목표로 하되, 정말 안 될 땐 최소 1명만 근무해도 괜찮다는 게
        // 실제 기준이다(사장님 지시: "기프트는 한명은 무조건 하루에 근무한다는 조건이야") —
        // 다른 코너는 그대로 오전/오후 둘 다 채워야 하는 하드 요건 유지.
        const hardFloor = corner === '기프트' ? 1 : needM + needA;
        if (remainM + remainA > cornerFlexible.length && cornerWorking.length < hardFloor) {
          conflicts.push({
            date,
            type: 'CORNER_SHIFT_MIN_VIOLATION',
            message: `${date}: '${corner}' 코너 오전/오후 최소 인원(오전 ${needM}명, 오후 ${needA}명)을 채울 인원이 부족합니다.`,
            employeeIds: cornerWorking.map((e) => e.id)
          });
        }

        // When the corner is short-handed (not enough flexible people to cover both morning
        // and afternoon minimums), afternoon takes priority — fill afternoon's need first,
        // morning gets whoever's left. This means a single available person defaults to
        // afternoon rather than morning.
        cornerFlexible.sort((a, b) => byMorningNeedAsc(b, a));
        const pickA = cornerFlexible.slice(0, remainA);
        const pickAIds = new Set(pickA.map((e) => e.id));
        const remainingCornerFlex = cornerFlexible.filter((e) => !pickAIds.has(e.id));
        remainingCornerFlex.sort(byMorningNeedAsc);
        const pickM = remainingCornerFlex.slice(0, remainM);
        const pickMIds = new Set(pickM.map((e) => e.id));

        flexible = flexible.filter((e) => !pickMIds.has(e.id) && !pickAIds.has(e.id));
        lockedMorning.push(...pickM);
        lockedAfternoon.push(...pickA);
      });

      // 오전/오후 최소·최대 인원은 부서(문구/서적)마다 따로 설정할 수 있다 — 문구는 최소=최대로
      // 묶여 있어도 서적은 최소보다 여유 있게 최대치를 더 둘 수 있다(사장님 지시: "문구는
      // 최소와 최대가 같지만 서적은 다를 수 있거든"). 별도 설정이 있는 부서만 자기 인원끼리
      // 따로 채우고, 설정이 없는 나머지(부서 미지정 관리 포함)는 예전처럼 매장 공통 기본값
      // 하나를 다같이 나눠 채운다 — 그렇지 않으면 매장 공통값이 부서마다 중복 적용돼 버린다.
      const overriddenDepts = Object.keys(deptRules).filter((d) => {
        const dr = deptRules[d];
        return dr && (dr.minMorningStaff != null || dr.minAfternoonStaff != null || dr.maxMorningStaff != null);
      });
      const shiftGroups = overriddenDepts.map((dept) => {
        const dr = deptRules[dept];
        const groupMinMorning = dr.minMorningStaff != null ? dr.minMorningStaff : 0;
        const groupMaxMorning = dr.maxMorningStaff != null ? dr.maxMorningStaff : (groupMinMorning > 0 ? groupMinMorning : Infinity);
        return {
          label: dept,
          minMorning: groupMinMorning,
          minAfternoon: dr.minAfternoonStaff != null ? dr.minAfternoonStaff : 0,
          maxMorning: groupMaxMorning,
          members: (e) => Model.employeeDepartment(e) === dept
        };
      });
      shiftGroups.push({
        label: null,
        minMorning,
        minAfternoon,
        maxMorning: minMorning > 0 ? minMorning : Infinity,
        members: (e) => !overriddenDepts.includes(Model.employeeDepartment(e))
      });

      const chosenMorning = [];
      const chosenAfternoon = [];

      shiftGroups.forEach((group) => {
        const groupFlexible = flexible.filter(group.members);
        const groupLockedMorning = lockedMorning.filter(group.members).length;
        const groupLockedAfternoon = lockedAfternoon.filter(group.members).length;

        const needMorning = Math.max(0, group.minMorning - groupLockedMorning);
        const needAfternoon = Math.max(0, group.minAfternoon - groupLockedAfternoon);

        if (needMorning + needAfternoon > groupFlexible.length) {
          conflicts.push({
            date,
            type: 'SHIFT_MIN_VIOLATION',
            message: `${date}: ${group.label ? group.label + ' ' : ''}오전/오후 최소 인원(오전 ${group.minMorning}명, 오후 ${group.minAfternoon}명)을 모두 채울 인원이 부족합니다.`,
            employeeIds: groupFlexible.map((e) => e.id)
          });
        }

        groupFlexible.sort(byMorningPreferenceThenNeed);
        const pickMorning = groupFlexible.slice(0, needMorning);
        const pickMorningIds = new Set(pickMorning.map((e) => e.id));
        const afterMorningPick = groupFlexible.filter((e) => !pickMorningIds.has(e.id));

        afterMorningPick.sort(byAfternoonPreferenceThenNeed);
        const pickAfternoon = afterMorningPick.slice(0, needAfternoon);
        const pickAfternoonIds = new Set(pickAfternoon.map((e) => e.id));
        const groupLeftover = afterMorningPick.filter((e) => !pickAfternoonIds.has(e.id));

        let groupMorningCount = groupLockedMorning + pickMorning.length;
        let groupAfternoonCount = groupLockedAfternoon + pickAfternoon.length;

        // 오전 최대 인원(설정 없으면 최소=최대)에 닿으면 남는 사람은 선호도와 무관하게 오후로
        // 보낸다. 최소도 최대도 없는 그룹은 기존처럼 선호/균형 기준으로 자유롭게 배정한다.
        groupLeftover.sort(byMorningNeedAsc);
        for (const e of groupLeftover) {
          let assignMorning;
          if (groupMorningCount >= group.maxMorning) {
            assignMorning = false;
          } else {
            const pref = shiftBias(e, date, dates, schedule, rules);
            const diff = morningCount[e.id] - afternoonCount[e.id];
            assignMorning = pref !== 0 ? pref < 0 : (diff < 0 || (diff === 0 && groupMorningCount <= groupAfternoonCount));
          }
          if (assignMorning) {
            pickMorning.push(e);
            groupMorningCount++;
          } else {
            pickAfternoon.push(e);
            groupAfternoonCount++;
          }
        }

        chosenMorning.push(...pickMorning);
        chosenAfternoon.push(...pickAfternoon);
      });

      [...lockedMorning, ...chosenMorning].forEach((e) => {
        schedule[e.id][date].shift = 'MORNING';
      });
      [...lockedAfternoon, ...chosenAfternoon].forEach((e) => {
        schedule[e.id][date].shift = 'AFTERNOON';
      });

      for (const e of workingToday) {
        if (schedule[e.id][date].shift === 'MORNING') morningCount[e.id]++;
        else afternoonCount[e.id]++;
      }
    }
  }

  // swapDates: which dates are eligible to swap on. allDates: the full month, used to
  // correctly measure consecutive-workday streaks across day boundaries not in swapDates.
  function rebalance(schedule, employees, allEmployees, swapDates, allDates, personalCap, cornerAllowedOff, offCount, conflicts, silent) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * swapDates.length * 4;
    let iterations = 0;

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId];
    }

    while (iterations < maxIterations) {
      iterations++;
      const sortedDesc = [...employees].sort((a, b) => offCount[b.id] - offCount[a.id]);
      const sortedAsc = [...employees].sort((a, b) => offCount[a.id] - offCount[b.id]);

      let swapped = false;
      outer: for (const eMax of sortedDesc) {
        for (const eMin of sortedAsc) {
          if (eMax.id === eMin.id) continue;
          if (offCount[eMax.id] - offCount[eMin.id] <= 1) break outer;

          let chosenDate = null;
          for (const date of swapDates) {
            if (
              sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
              statusOn(eMax.id, date) === 'OFF' &&
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCap(eMax.id, date) &&
              !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
            ) {
              chosenDate = date;
              break;
            }
          }

          if (chosenDate) {
            schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
            schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
            offCount[eMax.id]--;
            offCount[eMin.id]++;
            swapped = true;
            break outer;
          }
        }
      }
      if (!swapped) break;
    }

    if (silent) return;

    let maxOff = -Infinity;
    let minOff = Infinity;
    for (const emp of employees) {
      maxOff = Math.max(maxOff, offCount[emp.id]);
      minOff = Math.min(minOff, offCount[emp.id]);
    }
    if (maxOff - minOff > 1) {
      conflicts.push({
        date: null,
        type: 'IMBALANCE_NOTICE',
        message: `평일 휴무를 완전한 균형으로 맞추지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
        employeeIds: []
      });
    }
  }

  // Decoupled final rebalance: unlike rebalance() above, the day taken from the over-target
  // person and the day given to the under-target person don't have to be the same date. This
  // closes gaps that same-date swapping can't reach. Critically, this drives everyone toward
  // their OWN target[] count, not just toward each other — mutual closeness (e.g. everyone
  // within 1 of each other) isn't the goal; hitting the actual target number is (사장님 지시:
  // 휴무 개수가 최우선이니 목표에 정확히 맞춰야 함).
  //
  // If someone still can't be brought down to target under the normal cap (their locked days
  // happen to sit such that every fairness-off day they have would create an over-cap run if
  // worked), the cap is relaxed by +1 for that one person only, as a last resort — never
  // globally, and only once every normal-cap swap has been exhausted. This is escalated up to
  // +3 before giving up, since hitting the target always outranks the consecutive-work cap.
  function rebalanceDecoupled(schedule, employees, allEmployees, dates, personalCap, cornerAllowedOff, offCount, target, conflicts, excludeDatesForSlack, maxStaffAllowed) {
    if (employees.length < 2) return;
    const maxIterations = employees.length * dates.length * 8;
    const maxCapBonus = 3;
    let iterations = 0;

    const capBonus = {};
    employees.forEach((e) => { capBonus[e.id] = 0; });

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCapIfWork(empId, date, bonus) {
      const idx = dates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, dates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < dates.length && statusOn(empId, dates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId] + bonus;
    }
    // 최대 근무 인원(설정돼 있으면)을 이 그룹 자체 인원 기준으로 다시 넘기면 안 된다 — 이 값을
    // 지키려고 Phase 1이 일부러 페이스보다 더 많이 쉬게 한 날이 있을 수 있는데, trim/rebalance가
    // 그걸 모르고 다시 근무로 돌리면 최대 인원이 조용히 깨진다.
    function wouldExceedMaxStaffIfWork(date) {
      if (maxStaffAllowed == null) return false;
      const working = employees.filter((e) => statusOn(e.id, date) === 'WORK').length;
      return working + 1 > maxStaffAllowed;
    }
    function findReduceDate(empId, bonus) {
      for (const date of dates) {
        if (
          sourceOn(empId, date) === 'AUTO_FAIRNESS' &&
          statusOn(empId, date) === 'OFF' &&
          !wouldExceedCapIfWork(empId, date, bonus) &&
          !wouldExceedMaxStaffIfWork(date)
        ) {
          return date;
        }
      }
      return null;
    }

    while (iterations < maxIterations) {
      iterations++;
      // Over-target: currently more OFF days than their own target calls for. Under-target: fewer.
      const over = employees.filter((e) => offCount[e.id] > target[e.id]).sort((a, b) => (offCount[b.id] - target[b.id]) - (offCount[a.id] - target[a.id]));
      const under = employees.filter((e) => offCount[e.id] < target[e.id]).sort((a, b) => (target[b.id] - offCount[b.id]) - (target[a.id] - offCount[a.id]));
      if (over.length === 0 || under.length === 0) break;

      let swapped = false;
      outer: for (const eMax of over) {
        let reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        while (!reduceDate && capBonus[eMax.id] < maxCapBonus) {
          capBonus[eMax.id]++;
          reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        }
        if (!reduceDate) continue;

        for (const eMin of under) {
          if (eMin.id === eMax.id) continue;

          let increaseDate = null;
          for (const date of dates) {
            if (excludeDatesForSlack && excludeDatesForSlack.has(date)) continue;
            if (
              sourceOn(eMin.id, date) === 'AUTO' &&
              statusOn(eMin.id, date) === 'WORK' &&
              !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
            ) {
              increaseDate = date;
              break;
            }
          }
          if (!increaseDate) continue;

          schedule[eMax.id][reduceDate] = { status: 'WORK', source: 'AUTO' };
          schedule[eMin.id][increaseDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
          offCount[eMax.id]--;
          offCount[eMin.id]++;
          swapped = true;
          break outer;
        }
      }
      if (!swapped) break;
    }

    // If someone is still over target here, it's not because a swap partner couldn't be found —
    // it's because there's a genuine 1-day surplus in the total (Phase 1's daily pacing can round
    // up by one day over the month), and once everyone else sits exactly at their target there's
    // no one left "under" to hand the extra day to. A straight swap can only move the surplus
    // around, never remove it — so just drop it: convert the over-target person's rest day
    // straight to work, with no counterpart, shrinking the total by one.
    let trimIterations = 0;
    while (trimIterations < employees.length * 2) {
      trimIterations++;
      const stillOver = employees.filter((e) => offCount[e.id] > target[e.id])
        .sort((a, b) => (offCount[b.id] - target[b.id]) - (offCount[a.id] - target[a.id]));
      if (stillOver.length === 0) break;

      let trimmed = false;
      for (const eMax of stillOver) {
        let reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        while (!reduceDate && capBonus[eMax.id] < maxCapBonus) {
          capBonus[eMax.id]++;
          reduceDate = findReduceDate(eMax.id, capBonus[eMax.id]);
        }
        if (!reduceDate) continue;
        schedule[eMax.id][reduceDate] = { status: 'WORK', source: 'AUTO' };
        offCount[eMax.id]--;
        trimmed = true;
        break;
      }
      if (!trimmed) break;
    }

    // No conflict is logged here yet — fillCornerSlack (runGroupSchedule, right after this call)
    // can still close remaining gaps using leftover corner-cap slack, so checking "did we hit
    // target" this early would report a stale, overly pessimistic mismatch that fillCornerSlack
    // then quietly fixes. The real check happens once after that pass too.
  }

  // Spends leftover corner-cap slack (a day nobody in a capped corner is resting, even though
  // the cap would allow one more) on whoever in that corner is furthest below their OWN target —
  // target-relative, not just peer-relative, because if every member of a corner is uniformly
  // under target (e.g. all 6 people in a 3-corner group sitting at 8 with a 9-day target), a
  // purely peer-relative "even them out" check sees them as already balanced and does nothing,
  // even with plenty of unused slack sitting right there (confirmed on real data: a 6-person
  // corner group had slack on 29 of 31 days yet 4 of them stayed a day under target). Converting
  // a WORK day to OFF never violates that person's own consecutive-work cap (only the reverse
  // direction can), so no personalCap check is needed here.
  function fillCornerSlack(schedule, employees, allEmployees, dates, cornerAllowedOff, offCount, target, excludeDates) {
    const corners = Object.keys(cornerAllowedOff).filter((c) => cornerAllowedOff[c] != null);
    if (corners.length === 0) return;
    const maxIterations = employees.length * dates.length * 2;
    let iterations = 0;
    let changed = true;
    while (changed && iterations < maxIterations) {
      changed = false;
      iterations++;
      for (const corner of corners) {
        const members = employees.filter((e) => Model.employeeCorners(e).includes(corner));
        if (members.length < 2) continue;
        const underTarget = members.filter((e) => offCount[e.id] < target[e.id]);
        const candidatePool = underTarget.length > 0 ? underTarget : members;
        const sorted = [...candidatePool].sort((a, b) => offCount[a.id] - offCount[b.id]);
        const lowest = sorted[0];
        const highest = [...members].sort((a, b) => offCount[b.id] - offCount[a.id])[0];
        // Peer-relative fallback (spread > 1) only kicks in once nobody's under target anymore —
        // otherwise skip it entirely so this loop keeps lifting under-target members instead of
        // stopping the moment peers merely look "close enough" to each other.
        if (underTarget.length === 0 && offCount[highest.id] - offCount[lowest.id] <= 1) continue;
        for (const date of dates) {
          // Skip dates a sibling department is already short-staffed on — those are exactly the
          // dates backfillPartLeaders will need to pull someone from this corner back to WORK,
          // so granting rest here would just get reversed there.
          if (excludeDates && excludeDates.has(date)) continue;
          const cell = schedule[lowest.id][date];
          if (!cell || cell.status !== 'WORK' || cell.source !== 'AUTO') continue;
          if (wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, lowest, date)) continue;
          schedule[lowest.id][date] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
          offCount[lowest.id]++;
          changed = true;
          break;
        }
      }
    }
  }

  // Balances red-day (weekend/holiday) OFF within each single-corner group so members
  // take turns resting on red days roughly evenly; multi-corner/no-corner employees
  // fall back to a store-wide group.
  function rebalanceRedDays(schedule, employees, allEmployees, redDates, allDates, personalCap, cornerAllowedOff, redDayOff, conflicts) {
    if (employees.length < 2 || redDates.length === 0) return;

    const groups = {};
    employees.forEach((emp) => {
      const corners = Model.employeeCorners(emp);
      const key = corners.length === 1 ? Model.cornerFairnessGroup(corners[0]) || '__store__' : '__store__';
      if (!groups[key]) groups[key] = [];
      groups[key].push(emp);
    });

    function statusOn(empId, date) {
      return schedule[empId][date].status;
    }
    function sourceOn(empId, date) {
      return schedule[empId][date].source;
    }
    function wouldExceedCap(empId, date) {
      const idx = allDates.indexOf(date);
      let back = 0;
      for (let i = idx - 1; i >= 0 && statusOn(empId, allDates[i]) === 'WORK'; i--) back++;
      let fwd = 0;
      for (let i = idx + 1; i < allDates.length && statusOn(empId, allDates[i]) === 'WORK'; i++) fwd++;
      return back + fwd + 1 > personalCap[empId];
    }

    Object.entries(groups).forEach(([groupKey, groupEmployees]) => {
      if (groupEmployees.length < 2) return;
      const maxIterations = groupEmployees.length * redDates.length * 4;
      let iterations = 0;

      while (iterations < maxIterations) {
        iterations++;
        const sortedDesc = [...groupEmployees].sort((a, b) => redDayOff[b.id] - redDayOff[a.id]);
        const sortedAsc = [...groupEmployees].sort((a, b) => redDayOff[a.id] - redDayOff[b.id]);

        let swapped = false;
        outer: for (const eMax of sortedDesc) {
          for (const eMin of sortedAsc) {
            if (eMax.id === eMin.id) continue;
            if (redDayOff[eMax.id] - redDayOff[eMin.id] <= 1) break outer;

            let chosenDate = null;
            for (const date of redDates) {
              if (
                sourceOn(eMax.id, date) === 'AUTO_FAIRNESS' &&
                statusOn(eMax.id, date) === 'OFF' &&
                sourceOn(eMin.id, date) === 'AUTO' &&
                statusOn(eMin.id, date) === 'WORK' &&
                !wouldExceedCap(eMax.id, date) &&
                !wouldExceedCornerCap(schedule, allEmployees, cornerAllowedOff, eMin, date)
              ) {
                chosenDate = date;
                break;
              }
            }

            if (chosenDate) {
              schedule[eMax.id][chosenDate] = { status: 'WORK', source: 'AUTO' };
              schedule[eMin.id][chosenDate] = { status: 'OFF', source: 'AUTO_FAIRNESS' };
              redDayOff[eMax.id]--;
              redDayOff[eMin.id]++;
              swapped = true;
              break outer;
            }
          }
        }
        if (!swapped) break;
      }

      let maxOff = -Infinity;
      let minOff = Infinity;
      for (const emp of groupEmployees) {
        maxOff = Math.max(maxOff, redDayOff[emp.id]);
        minOff = Math.min(minOff, redDayOff[emp.id]);
      }
      if (maxOff - minOff > 1 && groupKey !== '__store__') {
        conflicts.push({
          date: null,
          type: 'IMBALANCE_NOTICE',
          message: `'${groupKey}' 코너는 빨간날(주말/공휴일) 휴무를 완전히 고르게 나누지 못했습니다 (최대 ${maxOff}일, 최소 ${minOff}일).`,
          employeeIds: []
        });
      }
    });
  }

  return { generateSchedule };
})();
