"""Choose varied source timestamps with local face detection; no face recognition."""
import random
import cv2

def face_timestamps(source, duration, count=4, progress=lambda message: None):
    detector = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    profile = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")
    capture = cv2.VideoCapture(str(source), cv2.CAP_FFMPEG, [cv2.CAP_PROP_N_THREADS, 2])
    if not capture.isOpened():
        raise RuntimeError("无法打开第一集视频进行人物画面筛选")
    samples = []
    rng = random.SystemRandom()
    try:
        for index in range(count):
            low = duration * (index+0.08)/count
            high = min(duration-1/30, duration*(index+0.92)/count)
            times = sorted({round(rng.uniform(low, max(low,high))*30)/30 for _ in range(8)})
            best = None
            for timestamp in times:
                capture.set(cv2.CAP_PROP_POS_MSEC, timestamp*1000)
                ok, frame = capture.read()
                if not ok:
                    continue
                scale = min(1, 720/max(frame.shape[:2]))
                small = cv2.resize(frame, (round(frame.shape[1]*scale),round(frame.shape[0]*scale)))
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
                faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(20,20))
                if len(faces)==0:
                    faces = profile.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(20,20))
                item = {"seconds":timestamp,"faceDetected":len(faces)>0,"faceCount":len(faces),"rangeStart":low,"rangeEnd":high}
                best = item
                if item["faceDetected"]:
                    break
            if best is None:
                raise RuntimeError("视频抽帧失败，无法生成截图时间点")
            samples.append(best)
            progress(f"已筛选人物画面 {index+1}/{count}" + ("" if best["faceDetected"] else "（该时段未检出人脸）"))
    finally:
        capture.release()
    rng.shuffle(samples)
    return samples
